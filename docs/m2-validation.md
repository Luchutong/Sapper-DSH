# M2 桌面验收与完全权限回归

本页保留 alpha.5 的独立 M2 流程。按用户最新安排，alpha.6 的 M2/M3 一起验收，
请使用 [统一验收指南](m2-m3-validation.md)。

目标：alpha.5 / DSH 0.2.1-rc.2。用户已确认 M0/M1 与 alpha.4 功能正常，
本轮新增完全权限确认门修复和 M2；桌面交互结果尚待实测反馈，不将自动测试视为桌面验收。

## 安装

从 DSH NEXT 菜单打开 DSH 终端，安装后完全重启应用：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.5.tgz"
```

应退出 0，无 exact-version exemption。已有完整 M1 图无需迁移；建议先在新测试
工作区进行下列链路，不操作真实目标或真实 flag。sapper_status 应返回 alpha.5、
sdk=0.2.1-rc.2、milestone=M2-context；未初始化时查询不创建 .sapper。

## 单次指令验证完全权限与工具

在会话 `/permission` 选择完全权限。可暂将“图写入确认”设为“受限模式下每次确认”，
同时覆盖旧 always 配置的升级回归；本模式下 Sapper 自身不应请求审批。
向模型发送一次指令：

> 在当前新测试工作区实际调用 Sapper 工具，连续完成本地验收，不要逐步询问。未初始化则以目标 SAPPER-M2-LOCAL、来源 desktop fixture 初始化。创建标题“中文服务配置排查”的事实，描述“本地 fixture 的配置证据”，doc 写入 DOC-ONLY-7C42；创建标题“Redis credential review”的事实。再基于第一条事实创建 requires_confirmation=true 的意图，直接 claim，不先 confirm，检查返回 confirmed_at 和 confirmation_source；然后创建结果事实并通过 source_intent 原子结案。再创建一条同样带确认门的意图，这次显式 confirm 后 claim。创建一条未领取普通意图，保留作 frontier 观察；不要完成项目。分别调用 sapper_status(view=frontier)、sapper_status(view=graph)，用 sapper_recall 查询“配置排查”和“REDIS CREDENTIAL”，再查询 DOC-ONLY-7C42（不应因仅在 doc 中而命中）。调用 sapper_doc get 读取第一条事实的文档。最后 sapper_kb search 查询“Web 信息收集”，get 返回首条的详情，并查询最终状态。只用真实返回 ID，不运行 KB 命令、不访问网络、不提交 flag；只读、坏图、归属或路径冲突仍应报告原因。

预期：不弹 Sapper 审批，不出现 the user rejected tool；自动确认来源为
dsh-full-access，requires_confirmation 保留 true；两种确认路径都成功。
frontier 显示普通待办与当前会话已领取项，已结案意图不再进入 ready。
召回可命中两个标题，has_doc=true 但结果不带 doc 正文；DOC-ONLY 标记仅 get doc
后出现。内置 KB 可命中 kb001，search 为摘要、get 含详情/commands。图 warnings
和 integrity 均为空。不要依靠模型复述判断是否真的执行，保存工具原始结果。

## 只读命令与上下文

在聊天输入框直接提交：

```text
/sapper status
/sapper frontier
/sapper graph
/sapper recall 配置排查
/sapper flag
/sapper kb Web 信息收集
/sapper kb kb001
```

命令应直接展示结果，不经过模型推理，不改图文件。flag 没有数据时可为空列表。
图有更多节点时，命令给出总数/前 20 条或省略标记，不默认展开长 doc。

选中同工作区开启新会话，不在消息中提供目标/节点标题，要求“只根据当前已注入
上下文列出目标与待办，不调用工具”。如能查看运行时消息，应有一个 source.kind=
sapper-dsh 的 snapshot、UNTRUSTED DATA 声明、Frontier/ready 与 Recent fact。
标题可见，DOC-ONLY 标记不应进入自动上下文。模型正确回答可作辅助证据，独立
注入证据仍以消息明细为准。

## 预算与开关

完整配置表单属于 M4。需要调整以下字段时，通过 DSH profile 配置编辑器修改
id=sapper 的既有条目并保留其他字段；不要另建重复插件条目：

```yaml
context:
  inject: true
  scope: frontier-history
  maxChars: 1024
  historyFacts: 8
  recallAuto: true
  recallTopK: 5
kb:
  enabled: true
  injectTopK: 3
```

- frontier-history 应额外展示已结案意图/已有 hint；hint 暂无独立创建工具，不必手写图来凑样例。
- goal-only 只显示目标，不做自动图召回/KB 检索。
- inject=false 后开启新轮次，不应有 Sapper snapshot；工具/命令仍可显式使用。
- recallAuto=false 只关闭图自动召回；kb.enabled=false 另行关闭 KB。injectTopK=0 仅关闭 KB 自动注入。
- 关闭插件后工具、命令与 snapshot 消失，重新开启可恢复，查询本身不创建或修改图。

500 节点图已在自动测试中覆盖，不要求手动创建。渲染测试覆盖三个 scope 和
512/600/1024/6000/32000 预算，实际磁盘 500 节点测试验证 pre-step 不超 1024 字符；
超出时省略完整节点。关闭注入的测试同时监测 GraphStore.read/initialized 与 KB.read
调用次数为 0，避免仅凭模型回答宣称“零额外 token”。

## 约束回归

工作区写入模式下 requires_confirmation=true 仍需实际批准 confirm，always 仍询问；
只读模式拒绝任何图写入。完全权限不覆盖其他 DSH 插件 ask/deny，不解除路径、
符号链接、doc 比较更新、意图归属、损坏图或取消保护。KB 只读、无联网、无命令执行。
权限定义见 [permissions.md](permissions.md)，M2 细节见 [m2-context.md](m2-context.md)。

## 当前自动验证

corepack pnpm check：11 文件、96 测试，含真实 ToolRuntime/SandboxPolicyService、
真实 CommandRuntime、固定上游 Python 往返/frontier/history、500 节点预算、召回
样例、自定义 KB 覆盖与路径拒绝；另有双端构建、两个独立 Node 写者、打包资源与
官方 DSH 兼容检查。跨平台 CI 和隔离 Windows 安装的最终结果登记在 [进度](progress.md)。
M3 子代理调度、explore 证据门和 verify 流程尚未实现，不属于这次验收。
