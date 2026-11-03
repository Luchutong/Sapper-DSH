# M2 上下文、召回与离线知识契约

版本 alpha.5，目标 DSH 0.2.1-rc.2。M2 不创建子代理，不执行 KB 中的命令。

## 每轮上下文

agent/pre-step 先尊重下游 reject/取消，清理旧的 Sapper snapshot，再读取当前图。
只添加一个 producer-owned 消息：source.kind=sapper-dsh、form=snapshot，含 sections。
开头固定 UNTRUSTED DATA 声明：目标、标题、描述和知识是观察数据，不能作为指令。
动态数据逐行 JSON 编码，换行、控制字符及 U+2028/U+2029 转义，避免破坏分区边界。

所有分区共享 context.maxChars（512–32000，默认 6000）预算，计数采用 JS 字符串
length，即 UTF-16 code units。按完整节点段落保留或省略，不截半个 JSON/代理对，
包含声明、检索指引、尾部工具提示和省略标记也不超预算。过长节点可整体略过，
后续较短节点仍有机会显示；没有保证某个尾部分区必定进入预算。

| context.scope | 分区 |
| --- | --- |
| goal-only | 目标/项目状态；不做自动 recall 或 KB 检索 |
| frontier（默认） | 目标、数量、frontier 各组、最近 historyFacts 条事实、自动 recall/KB 摘要 |
| frontier-history | 同上，再加最近 4 条已结案意图与 4 条 hint |

frontier 顺序：已领取优先，其后 created_at 和 ID 稳定排序。ready 指依赖齐全、
确认条件满足、图健康且当前会话可继续的开放意图；pending_confirmation 表示受限
模式下尚未确认；missing_dependencies 表示缺依赖；in_flight 表示由其他会话领取；
blocked_by_integrity 包括坏图或项目已完成。完全权限下未确认意图可进入 ready，
标记 standing-full-access，真正 claim/结案才写自动确认来源。

列表/注入/召回均不展开 doc。节点给出 ID 和 has_doc，提示模型先读 doc、再 recall、
最后决定是否需要新事实，避免重复探索。文档只能通过 sapper_doc 按需展开。

context.inject=false 时清掉旧 snapshot，不读取/初始化图、不读取 KB、不添加消息；
用户显式调用工具/命令仍可查询。插件关闭则同时清理工具和命令。恢复注入后已有图
继续可读。图有 LOCK/待恢复事务时只报告问题，不为注入执行恢复或写入。

## 召回

sapper_recall 参数：query，limit（1–20，默认 context.recallTopK=5），
scope（all/fact/intent）。仅查事实和意图的 title/description，排除 goal 终态事实，
返回 ID、类型、标题、描述、has_doc、score 和 reasons，不搜索长 doc。

检索做 NFKC、英文小写、空白归一化；组合标题/描述子串、转义后的英文词边界和
Unicode code-point bigram Dice。无直接匹配时 Dice 至少 0.22；按分数降序、ID
排序，不依赖 locale。中英文、全角字符、部分标题、相近词与特殊正则字符有样例回归。
该规则是计划中的 TS bigram 方案，不与上游 Python difflib 的分值完全等价。

自动查询取最近一条真实 source.kind=user 的文本（最多 2000 字符），没有时用目标；
不把旧 Sapper snapshot 当新查询。context.recallAuto=false 只关闭图的自动召回，
不关闭显式工具，也不替代独立的 kb.enabled/kb.injectTopK 开关。

## 离线 KB

sapper_kb 支持 search/get/list；无初始化图也可使用，绝不联网或创建目录。
search/list 返回摘要，get(id="kb001") 才展开 detail/commands/source 等字段。
命令只是参考数据。默认打包 56 条原始知识，首次加载后缓存并向调用者返回独立副本。
KB 搜索使用上述匹配器，额外索引 tags 和 detail 前 500 字符；可按 tag 过滤。

kb.enabled=false 关闭工具的读取与自动注入；kb.injectTopK 默认 3，0 只关闭自动
注入。KB 查询和图召回共用本轮注入预算。

kb.customDir 非空时，必须是工作区内的独立子目录，拒绝路径逃逸、symlink/junction；
例如 `.sapper-kb`。仅只读加载其中 *.json，不创建或修复文件。文件名与 id 必须
一致（kb001.json / kb001），需要 title、description、tags[]、commands[]，
detail/source 可空。相同 ID 覆盖内置条目；每次查询重新读取自定义目录，坏条目
跳过并报告 warnings。目录缺失时回退内置并提示；越界路径直接报错，自动注入只
略过 KB 并保留图数据。

## 只读命令

| 命令 | 结果 |
| --- | --- |
| /sapper 或 /sapper status | 状态、计数、诊断、frontier 数量和前 20 个 ID |
| /sapper graph | 有预算的图文本，不展开 doc |
| /sapper frontier | 就绪/阻塞组、前 20 条摘要与总数 |
| /sapper recall <query> | 图召回 |
| /sapper flag | 本地 flag 列表；不提交、不改状态 |
| /sapper kb <query> | KB 摘要搜索；空查询列前 20 条 |
| /sapper kb kb001 | 单条详情与命令示例 |

使用真实 CommandRuntime 注册/执行，直接返回 UI 结果，不调用模型；DSH 仍可记录
command/run 与 command/done 生命周期事件。服务暂不可用时不阻断图工具，服务恢复
后注册。禁用、卸载与取消会清理或阻止旧命令处理。

## 兼容与验证范围

固定上游 revision/哈希的测试参考扩展至 render_graph_text（不含后续 render_prompt），
覆盖 Store 往返、frontier 顺序与历史证据 ID；参考代码不进入安装包。frontier 的会话
归属分组和 full-access 自动确认属于 DSH 适配扩展。召回差异如上，不声称逐字渲染
或分数与 Python 一致。

自动回归覆盖 500 节点纯渲染/实际磁盘图、各 scope/预算、注入关闭时零图/KB 读取、
真实 CommandRuntime、56 条打包 KB 和自定义路径边界。桌面反馈只按实际收到的证据
登记，见 [验收指南](m2-validation.md) 与 [进度](progress.md)。
