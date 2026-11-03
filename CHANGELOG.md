# Changelog

## 0.1.0-alpha.7 — 2026-11-04

- 根据桌面反馈记录 M2 通过、M3 的 r001 因缺少外部工具与 max-tokens 失败；M3 桌面回归仍待完成。
- 修复仅查询全局工具而过滤掉 preset 祖先作用域中 read/pwsh 等能力的问题；按子会话继承链应用白名单。
- M3 子会话独立声明 native 呈现，兼容父 preset 的 PTC 模式，保留父会话、preset 与其他策略的限制。
- 启动时检查 explore/verify 外部取证能力；缺失则在模型请求前报错，并终止本轮，不回退 reason 空耗 token。
- 单次输出默认预算由 4096 调为 8192；保留显式配置。max-tokens/未完成结构化结果与超时停止本轮，不追加 reason 重试。
- 运行记录新增 children 工具清单与预算；旧图/运行记录无需迁移，已开放 i002 可直接在新运行继续推进。
- 新增真实 AgentPresetRegistry/Loader、preset-scoped 工具、PTC、工具缺失、旧 i002 重跑及各角色 token 耗尽回归。

## 0.1.0-alpha.6 — 2026-11-03

- M3：真实 DSH spawn 子会话，reason/explore/verify 结构化输出与独立角色工具约束。
- 新增 sapper_dispatch reason/explore/verify/run/status/recover，以及 /sapper run、/sapper runs。
- 候选保存在 runs，不直接写事实；晋升要求两次独立子会话的实际成功工具输出，普通结案工具不能绕过 M3 门禁。
- 复核失败回退为开放意图、hint 与可召回 last_failure；同一候选跨调用复核预算持久化。
- 步数、探索、复核、并发、超时、每子会话步数/输出 token 上限、角色模型与外部工具白名单。
- 完全权限自动授权，保留受限模式审批、只读、其他策略、权限撤销、禁用和取消；回收已发布的子代理。
- 项目完成要求 reason 标注目标意图且独立 verifier 确认整个目标；事实、结案、运行记录和终态同一事务。
- 116 项测试（含 20 项真实 AgentLoop/SubagentRuntime 集成）；M2/M3 改为统一桌面验收，尚未登记用户验收通过。

## 0.1.0-alpha.5 — 2026-11-03

- 用户确认 alpha.4 功能正常；完全权限成为 Sapper 自身确认门的持续授权，覆盖 always 和 requires_confirmation，自动确认记录 dsh-full-access 来源。
- 保留 DSH 其他策略的 deny/ask、只读拒绝、工作区边界、归属、比较更新、坏图和运行中权限撤销保护。
- M2：就绪/阻塞 frontier、近期事实、结案历史与 hint、单一字符预算与整节点省略；关闭注入后不读图或 KB。
- 新增 sapper_recall 与 sapper_kb，中英文归一化子串、词边界、bigram Dice 召回，56 条离线 KB 与安全的工作区自定义覆盖。
- 新增只读 /sapper status、graph、frontier、recall、flag、kb；接入同版本真实 CommandRuntime，命令不调用模型。
- 96 项测试覆盖 500 节点预算、真实权限/命令管线和固定上游 Python 的 frontier/history 对照；新增 M2 验收与上下文契约文档。

## 0.1.0-alpha.4 — 2026-11-03

- M1 已获用户验收；修复普通图写入反复审批与 never 策略冲突的问题。
- 默认 store.approval=session，图维护连续执行；显式确认点和可选 always 模式保留审批。
- 接入同版本 SandboxPolicyService，拒绝只读/越界/缺失策略服务，提交前检查权限撤销。
- 旧 orchestration.requireApproval 不控制图存储，升级无需手工迁移配置或图文件。
- 设置页新增图写入策略，使用真实嵌套 mutation 协议；更新连续执行验收与权限契约。

## 0.1.0-alpha.3 — 2026-11-03

- M0 由用户确认验收完成，交付 M1 存储与六个工具。
- Python 兼容图文件、节点/引用校验、ID 分配、文档比较更新与意图生命周期。
- per-root 队列、TS 跨进程锁、原子替换和可恢复多文件事务。
- 本地 flag 捕获去重、权威事实与可重建 ledger、显式状态更新，不联网提交。
- 接入真实 DSH 写审批和禁用守卫；敏感状态操作始终询问。
- 固定上游 Store 快照的 Python/TS 往返与两个独立 Node 写者验证。
- 发布 M1 验收/存储指南；global / autoInit、frontier / recall 与编排仍待后续阶段。

## 0.1.0-alpha.2 — 2026-11-03

- 对齐 DSH 0.2.1-rc.2、Cordis 4.0.5、Schemastery 3.18.5。
- 迁移 volatile Config、SettingsForms、configForms 与当前客户端插槽。
- 使用 producer-owned 消息来源；处理配置写入返回 false 的情况。
- 在测试、CI 和打包中加入官方 DSH 安装兼容检查，保留旧包拒绝回归。
- 记录旧 SDK 缓存导致安装失败的原因，更新安装和验收文档。

## 0.1.0-alpha.1 — 2026-11-03

- 初始 M0 宿主/客户端骨架，目标为旧 SDK 0.1.5-rc.1。
- 已确认无法安装到 DSH 0.2.1-rc.2；由 alpha.2 替代。
