# 自动化与权限策略

适用版本：sapper-dsh 0.1.0-alpha.4，DSH 0.2.1-rc.2。

设计目标：用户已授权的任务可以连续推进；正常记忆、任务状态与证据维护不逐次打断。
约束落在会话文件权限、工作区边界、数据完整性和用户明确要求的决策点。

## 默认行为

| 操作 | 默认策略 |
| --- | --- |
| status / list / get | 只读；不请求审批，不创建或修复图 |
| init / recover、事实与文档写入、普通意图领取/释放/结案 | DSH 会话允许写入当前工作区时自动执行 |
| 本地 flag 捕获、去重、状态记录 | 自动维护本地图数据；不调用网络提交 |
| conclude 到 goal | 自动记录本地图的完成状态；不代表已验证外部任务成功 |
| 显式 requires_confirmation=true 的意图 | 领取/结案前必须经用户批准 confirm；正常自动化意图默认 false |
| 用户选择“每次写入确认” | 每次写入请求 DSH 审批，是可选覆盖 |
| 只读会话、权限服务缺失、工作区越界、图损坏 | 拒绝写入并给出原因，不自动升级权限 |

默认 `store.approval=session`。插件在执行前、排队后、提交前调用真实
`ctx.sandboxPolicy.resolve({ session })`：只允许 workspace-write 和
完全权限模式中的当前会话工作区子目录。read-only 禁止修改图；即使会话为
完全权限，插件仍只操作工作区内的图目录，不开放任意路径写入。

调用期间文件权限、配置、工作区改变时取消原写入；插件关闭/卸载与取消信号也会
阻止未提交写入。事务日志已经提交后，存储层完成该事务以保持可恢复一致性，具体
提交点与跨进程限制见 [存储说明](m1-storage.md)。

其他 DSH 插件返回的 deny / ask 原样保留。代码不修改 DSH 审批策略，不伪造批准，
不设置 sandbox escalation。普通图写入不产生额外 ask，因此在允许文件写入的
never 会话中也能连续执行。显式确认点和用户选择的 always 模式仍可能被 never 拒绝，
这是用户选定约束的结果。

## 配置与升级

在“设置 → Sapper → 图写入确认”选择：

- **跟随会话权限（自动）**：默认选项，store.approval=session。
- **每次写入确认**：显式覆盖，store.approval=always，需要可交互的审批环境。

旧 alpha.3 的 orchestration.requireApproval=true 不再控制图数据写入。该字段保留
给后续外部编排策略；升级无需删除旧配置或手工改 profile。没有 store.approval 的
旧条目按 schema 得到 session。磁盘上的项目与节点格式保持不变，已有图无需迁移。

嵌套设置通过 ConfigForm.mutate 的路径数组 ['store', 'approval'] 写入。SDK 的
set(field, value) 只写顶层字段，不解析点号路径，不能使用 set('store.approval', ...)。

## 自动化范围

M1 已提供可连续调用的图存储工具，权限修复消除了正常数据维护的人工审批循环。
完整 frontier、recall 和 reason/explore/verify 调度仍分别属于 M2 / M3；本版本不宣称
已经实现完整自主解题器。后续执行命令、网络操作、真实提交等外部能力继续由 DSH
管理权限与必要审批；内部图写入的自动权限不会授予这些外部能力额外权限。

requires_confirmation 默认为 false。普通意图不应为了例行记录而设置为 true；只有
任务或用户明确要求人工决策时才设置。已有明确确认点不会在升级中被静默清除。
M3 的证据复核与预算约束仍按路线图实现，不能用跳过人工提示来代替结果验证。
