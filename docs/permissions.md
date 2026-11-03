# 自动化与权限策略

适用版本：sapper-dsh 0.1.0-alpha.7，DSH 0.2.1-rc.2。

设计目标：用户已授权的任务可以连续推进；正常记忆、任务状态与证据维护不逐次打断。
约束落在会话文件权限、工作区边界、数据完整性和用户明确要求的决策点。

## 默认行为

| 操作 | 默认策略 |
| --- | --- |
| status / list / get | 只读；不请求审批，不创建或修复图 |
| init / recover、事实与文档写入、普通意图领取/释放/结案 | DSH 会话允许写入当前工作区时自动执行 |
| 本地 flag 捕获、去重、状态记录 | 自动维护本地图数据；不调用网络提交 |
| conclude 到 goal | 自动记录本地图的完成状态；不代表已验证外部任务成功 |
| 显式 requires_confirmation=true 的意图 | 完全权限下 confirm 或首次领取/结案时自动确认；workspace-write 须实际批准 confirm |
| 用户选择 store.approval=always | 完全权限下自动执行；workspace-write 每次写入请求审批 |
| 只读会话、权限服务缺失、工作区越界、图损坏 | 拒绝写入并给出原因，不自动升级权限 |

默认 `store.approval=session`。插件在执行前、排队后、提交前调用真实
`ctx.sandboxPolicy.resolve({ session })`：只允许 workspace-write 和
完全权限模式中的当前会话工作区子目录。read-only 禁止修改图；即使会话为
完全权限，插件仍只操作工作区内的图目录，不开放任意路径写入。

调用期间文件权限、配置、工作区改变时取消原写入；插件关闭/卸载与取消信号也会
阻止未提交写入。事务日志已经提交后，存储层完成该事务以保持可恢复一致性，具体
提交点与跨进程限制见 [存储说明](m1-storage.md)。

其他 DSH 插件返回的 deny / ask 原样保留。代码不修改 DSH 审批服务，不伪造用户审批
事件，不设置 sandbox escalation。DSH never 会拒绝实际提交的 ask；本插件根据用户
要求，将真实 danger-full-access 视为自身确认门的持续授权，不制造额外 ask。
不能仅凭 never、审批提示关闭或模型口头描述判定为完全权限。workspace-write 下的
显式确认点/always 仍可能被 never 拒绝，按该会话实际策略处理。

自动确认保留 requires_confirmation=true，在同一存储事务中记录 confirmed_at 与
confirmation_source="dsh-full-access"，不接受模型指定的权限覆盖参数。只读查询和
frontier 展示不会补写确认。其他 DSH 策略的 ask/deny 即使在完全权限下也保持原样。

## 配置与升级

在“设置 → Sapper → 图写入确认”选择：

- **跟随会话权限（自动）**：默认选项，store.approval=session。
- **受限模式下每次确认**：store.approval=always，workspace-write 逐次审批，完全权限自动通过。

旧 alpha.3 的 orchestration.requireApproval=true 不再控制图数据写入。该字段保留
给后续外部编排策略；升级无需删除旧配置或手工改 profile。没有 store.approval 的
旧条目按 schema 得到 session。alpha.4 → alpha.5 无需改图或删除旧配置，旧 always
在完全权限下同样自动执行。已有未确认意图在下次获授权领取/结案时自动确认，
不批量扫描或改写历史。图格式保持不变。

嵌套设置通过 ConfigForm.mutate 的路径数组 ['store', 'approval'] 写入。SDK 的
set(field, value) 只写顶层字段，不解析点号路径，不能使用 set('store.approval', ...)。

## M3 编排授权与角色约束

sapper_dispatch 的 reason/explore/verify/run 与 recover 是工作区写入操作；status 是只读。
完全权限沿用持续授权，即使 orchestration.requireApproval=true 或 store.approval=always
也不额外 ask。workspace-write 中，requireApproval=true 会在启动编排时请求审批；
已有 requires_confirmation 意图仍需各自的实际确认。设置 false 不授予额外文件权限。

reason 仅使用只读 Sapper 工具；explore 可以读取相关图资料和配置白名单中的外部工具；
verify 不开放 Sapper 图工具。子会话不能通过这些工具写事实、结案、委派或通信；
M3 意图的存储层门禁同时阻止父会话用普通 fact/conclude 绕过独立复核。

外部工具默认包括文件读取/搜索、bash/pwsh（explore 还可搜索/读取网页）；它们仍受
实际 DSH 沙箱和其他策略控制。白名单限制工具入口，不构成对任意 shell 脚本的独立
OS 沙箱。不能把图/KB、候选或角色 prompt 当成外部执行授权。子会话使用 DSH 的
委派权限继承；DSH 给子会话固定 never 的行为不由插件更改，受限操作可能被拒绝。

执行中的权限撤销、配置改变、关闭/卸载或取消会停止并回收子代理。取消后的本地图
清理仍重查当前权限；若已失去写权限，不强写失败状态，保留可见 running/claimed。
恢复权限并确认原执行者已退出后，调用 dispatch recover；同进程活跃运行不能恢复。

requires_confirmation 是决策门，verification_status 是证据复核结果，两者含义不同。
完全权限可以满足前者，不能代替后者；普通 M1 观察事实也不会因此标成 confirmed。
详见 [M3 契约](m3-orchestration.md) 和 [统一验收](m2-m3-validation.md)。
