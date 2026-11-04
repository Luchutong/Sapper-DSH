# 项目进度

**当前交付 alpha.12：发现 flag 即停、主会话阶段与方向控制、结束后的 WP/纠错关联阶段。M2 用户验收已通过；alpha.7 的真实 M3 验收失败已作为本版回归依据。最新说明见文末与 [任务面板](task-panel.md)。**

更新：2026-11-04（Asia/Shanghai）。当前 alpha.12，DSH 0.2.1-rc.2。

**M0/M1 已验收；本次桌面反馈确认 M2 通过。alpha.6 的 M3 因工具作用域与 token 耗尽失败，alpha.7 工具传递已恢复，但桌面证据转义仍失败；alpha.8 修复并加入任务面板。**
[阶段跟踪 issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 |
| --- | --- | --- |
| M0 | 用户已验收 | 桌面安装/设置/工具/目标摘要 |
| M1 | 用户已验收 | 事实图、六个基础工具、文档/归属、flag、本地锁/事务恢复 |
| alpha.4 权限修复 | 用户反馈正常 | 普通图维护连续自动执行 |
| alpha.5 完全权限修复 / M2 | alpha.6 桌面反馈通过 | 完全权限确认门、frontier/历史/预算、recall/离线 KB、只读命令 |
| alpha.6 / M3 | 桌面验收遇阻 | 真实子代理、证据门、运行记录、预算/并发/模型/取消/恢复 |
| alpha.7 / M3 修复 | 工具可用，证据门禁仍遇阻 | preset 工具继承、native 呈现、缺能力/预算耗尽停止、工具清单 |
| alpha.8 / M3 优化与面板 | 工程回归通过 | 回执证据、普通工作区任务隔离、发起/继续/取消面板与 RPC |
| M4 完整设置/图编辑 | 部分实现 | 已有预算表单、进度时间线和只读关系图；其余高级表单与图编辑器待实现 |
| M5 | 未开始 | 干净环境、迁移与最终发行验收 |

## 本次桌面反馈与修复

用户报告 alpha.6 的源事实、普通意图原子结案、中英文召回、doc-only 排除、离线 KB
与图/frontier 状态全部通过。M3 的 r001：reason 创建 i002；explore 的工具列表没有
read/pwsh 等外部能力，耗尽 4096 token；回退 reason 再次 max-tokens。没有候选、
verify 或 confirmed 事实，意图回到 open/ready，图 integrity 为空。

定位到 alpha.6 用 tools.get(name) 全局视图过滤子会话工具，漏掉桌面 preset 祖先层。
原测试把 read 注册全局，未覆盖此拓扑。真实 Loader/AgentPresetRegistry 新测试先
复现失败，再验证修复通过；实际 ASAR 的祖先工具规则也与同版本 npm 代码核对。

alpha.7：按 scopeParentOf(child) 查询并限制继承工具，独立 native 呈现兼容 PTC；
启动前检查外部能力并记录 children.tools/external_tools/max_output_tokens。无外部
能力、max-tokens/未完成结构化结果、超时直接停止，不追加 reason 浪费预算。
默认 maxOutputTokens 调为 8192，旧显式 4096 保留；角色提示要求简短推理并及时结束。

旧图/运行不迁移，不修改本次真实工作区；回归验证已失败 r001 原文保留，原 i002
直接在新 r002 推进并确认，无需 init 或手工写 confirmed。先看统一指南中的“重跑
已有 i002”段落；这次不要求重复已通过的 M2。

## M3 基础交付（沿用）

- sapper_dispatch 的 reason/explore/verify/run/status/recover；/sapper run 与 /sapper runs。
- 使用 DSH 内置 spawn、结构化输出与真实 AgentLoop；子会话独立，不使用第三方 CLI。
- reason 只读，explore 提交有实际成功工具输出的候选；verify 另起子会话独立复核。
  候选不入事实图，成功后原子晋升 confirmed、结案并记录运行证据。
- M3 意图的普通 fact/conclude 绕过路径由存储层拒绝；失败重新开放，留下 hint 与
  可召回 last_failure。复核次数跨调用持久化，引用旧 run_id 也不能重置。
- reason 的目标标记加独立 verify 的 goal_achieved 才完成项目；仅确认中间事实不自动完成。
- 意图数、探索数、复核数、并发、子会话超时/步数/输出 token、角色模型与工具白名单。
- 完全权限下包括旧 always/requireApproval 配置均自动授权；其他 DSH 策略、只读、
  路径、归属、坏图、取消、配置变化与权限撤销约束保留。停止并回收精确 activation。
- 取消清理仍服从当前写权限；失去权限时保留 running/claimed，恢复权限后显式恢复。
- 沿用 M2 的 500 节点预算、注入关闭零额外图/KB 读取、56 条知识与查询命令。

## alpha.7 验证证据

- 类型检查、124 项测试（12 文件）与双端构建通过；其中 28 项使用真实 DSH
  AgentLoop/SubagentRuntime/ToolRuntime 和确定性本地模型，另测真实 CommandRuntime。
- 正常链路、无证据/伪造证据/复核失败不写事实、上下文隔离、门禁绕过拒绝、跨调用
  maxVerify、并发/步数/超时、取消回收、只读/受限审批/完全权限、权限撤销与恢复通过。
- 固定上游 Python Store/frontier/history、两个独立 Node 写者、打包 VM/KB 与官方
  兼容门禁继续保留；SDK peers 均与运行时一致，不授予版本豁免。
- 冻结锁文件离线安装通过；新增 preset/PTC、缺工具提前停止、原 i002 重跑与各阶段
  max-tokens 停止回归。隔离 Windows DSH NEXT 安装器完成 alpha.6 → alpha.7 升级，
  INSTALL_EXIT_CODE=0，无版本豁免；归档与安装后 host 哈希逐项核对一致。
  日志 dist/validation/windows-upgrade-alpha7.log，实际 desktop profile 与用户图未修改。
- 跨平台 CI 为 Ubuntu/Windows × Node 22/24，本轮结果见 Actions 与 issue #1。

确定性模型证明机制与接口，未调用在线模型/真实目标；真实模型判断与桌面交互按
[统一指南](m2-m3-validation.md) 验收。现有 desktop profile 不由本轮脚本修改。

## 历史记录

M0：alpha.2 安装、状态变化与目标摘要已由用户确认。M1：alpha.3 图维护、确认/领取、
原子结案、重复结案与完整性结果由用户确认。alpha.4 用户反馈功能正常，同时要求
完全权限默认通过审批；alpha.5 实现该要求和 M2。用户随后要求推进 M3 与 M2 合并验收；本次 alpha.6 反馈明确 M2 通过、M3 遇阻，
因此后续只将 M3 重跑和剩余反例列为待验收，不把本地测试当作桌面通过。

历史 alpha.4（65 项）和 alpha.5（96 项）的 Ubuntu/Windows × Node 22/24 CI 全绿，
Windows 隔离 profile 完成 alpha.3 → alpha.4 → alpha.5，无版本豁免。旧 tgz 保留。
alpha.5 SHA256：7de366f7e21e733efc955da4186a57a927619f965e0b1e43ce8b9983dcdf42d6。
历史日志在 dist/validation；兼容与权限事故经验见 lessons-learned.md。

下一步按统一指南在原工作区重跑 M3 i002，确认新记录工具清单、独立证据与终态；
通过后再进入 M4。当前只有 workspace 存储，global 与普通聊天自动触发仍预留。
TS/Python 写者须顺序交接，Python 不提供本插件 M3 门禁。

本机交付：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.7.tgz`，附 SHA256 文件。
SHA256：`8ee81d62be82236a7911f44ddbaea8fedcb75e984e51d56ea4aecd1378ac0c41`。
仓库 dist 与 Windows 同步目录一致，旧 alpha.6 包保留。

## alpha.8：证据回执与任务面板

用户 alpha.7 实测证明外部 pwsh 工具已经可用，但引用中的再次转义导致 exact-excerpt 拒绝真实输出，M3 仍未通过桌面验收。本版以每个子会话的服务端证据回执替代模型复制长输出，保存原始调用标识、工具、摘要与输出 SHA256；verify 必须获得自己独立调用的回执。

新增普通工作区任务面板（会话输入区与插件设置页），发起/继续/取消和任务记录；新目标自动建独立任务图，旧 legacy 图可继续，不要求专用 workspace 或手工造图。RPC 经主客端 Typert 与 ToolRuntime，沿用真实会话权限。

回归新增 Windows 路径/CRLF 输出、回执隔离、普通目录从零启动、多个任务隔离、旧失败图继续、面板后台取消、只读拒绝、真实主客端 Gateway 与 UI 操作。详见 [任务面板](task-panel.md)。原始用户测试记录保留本地，不将确定性模型测试表述为真实模型验收通过。

alpha.8 最终工程验证：131 项测试（12 文件）通过；34 项真实 M3/面板编排测试覆盖回执、隔离、旧图继续、权限及取消，主客端 Typert Gateways 均实际参与。构建产物浏览器探针通过、pageerror 为零，并确认第二个任务在面板显示完成；冻结锁文件离线安装、包内依赖/兼容检查通过。Windows 隔离 profile 完成 alpha.7 → alpha.8 安装，退出码 0，无版本豁免；安装后 host SHA256 与本地 lib 完全一致。

交付包：`sapper-dsh-0.1.0-alpha.8.tgz`，SHA256 `19e326e01833aa569d4c0b968a75dd1d870251a18e1a5e7762444df5d78d65e8`。副本位于 Windows `D:\BaiduSyncdisk\sapper移植`。现有 desktop profile 和用户验收事实图未修改。

## alpha.9：早期图兼容补充

保留 M0 最小图或不可读取的旧图时，面板显示诊断并继续列出、监控独立的新任务，避免未选中的历史图阻断整个面板。旧文件原文不改写。补充真实子代理回归，确认旁置旧 M0 图的新任务可独立完成。

alpha.8 的 Ubuntu/Windows × Node 22/24 最终 CI 通过。首次 Windows Node 22 暴露旧测试用 120ms 猜测子会话启动速度的时序假设；现改为等待 explore 发布后触发实际注册的超时回调。产品运行时超时策略未因此改变。

alpha.9 最终本地验证：132 项测试（12 文件，35 项真实编排/面板测试）、类型、双端构建与打包检查通过。使用最终构建的宿主与客户端再次通过真实 Gateway + 浏览器的发起任务/独立复核探针。交付 `sapper-dsh-0.1.0-alpha.9.tgz`，SHA256 `07a1b4bd4d4b2845d895b2681d14ee7e2c9824f9f23a202e4ae1b25f8f2203d9`，副本位于 Windows `D:\BaiduSyncdisk\sapper移植`。

## alpha.10：新会话命令快速受理

用户实测新工作区 `/sapper start` 提交后输入框只读、首页停留。只读检查实际会话和图，确认后台有成功复核事实，旧命令等待整轮 58/161 秒才返回，导致 DSH 输入器一直停在 submitting。

start/run 命令改为与面板共享后台任务管理器，立即返回 job ID；增加 job/cancel 命令，保留独立取消、ToolRuntime 权限、配置撤销、清理完成前防重入。面板自动展示命令任务，运行时可编辑下一目标。补充真实 DSH SubmitMachine + CommandRuntime + 阻塞子代理回归，覆盖旧测试遗漏的新会话输入器结算路径。原始用户工作区和会话仅作只读诊断，不改写真实运行或事实。

alpha.10 本地验证：135 项测试（12 文件）、类型、双端构建、冻结锁文件离线安装及打包/兼容检查通过；37 项真实编排测试包括实际 DSH 输入器状态机的快速结算与后台取消。浏览器面板流程继续通过。交付 `sapper-dsh-0.1.0-alpha.10.tgz`，SHA256 `b79326919616e9184c3f2717a10ada54a9636403c88adb99175f1e10c3993bd4`，已复制到 Windows `D:\BaiduSyncdisk\sapper移植`。

## alpha.11：test2 预算与桌面反馈修复

只读检查 test2：r001 约运行 116 秒后因 12 步上限停止，explore 已产生候选，verify 在第 12 步获得相同独立结果但没有结构化提交机会。未写入 confirmed，3 个意图仍开放，图完整性正常。主会话缺少结果回传，加之旧任务入口不醒目、设置页 remote 命名空间注入错误，使用户无法看到实际进展。

本版提高默认预算并加入按新证据延期和结构化收尾；新复核可复用旧候选，仍需要新会话的独立成功工具回执。增加持久化主会话结果卡片及历史补发、输入区可见按钮与视口弹窗、子代理时间线、只读关系图和结果/候选视图。设置页修复 scoped remote，并增加可编辑预算字段。未修改真实 test2 图，未重试其外部目标。

alpha.11 验证：144 项测试（13 文件，其中 42 项真实 SDK 编排/面板测试）、类型、双端构建、冻结锁文件离线安装和官方兼容/包检查通过。另对最终构建运行 4 项宿主回归，包含真实 scoped Gateway、构建客户端浏览器窗口/结果流程、超过旧 12 步复核、复用候选及主会话结果回传。同版本 SDK 实际历史组装器与 Chat builder 覆盖实时与历史结果展示。确定性模型测试不代替在线桌面模型验收。

产物 `sapper-dsh-0.1.0-alpha.11.tgz`，SHA256 `9e41b8e5c6a4e1f7b735fb4858b8b90688170f5568bd72264934ef52bcab146d`，已复制到 Windows `D:\BaiduSyncdisk\sapper移植`。DSH 0.2.1-rc.2 隔离 profile 升级退出 0，无兼容豁免；已安装宿主 SHA256 与本地构建相同（`052f65c3b4a76200251a7ad995764636c6011bf7474f80a7e46d4ffd40c18388`）。没有修改日常 desktop profile。

## alpha.12：test3 结束条件、主会话干预与 WP/纠错

[test3 检查](test3-review.md)确认 f002 已保存独立复核的 flag，但旧流程未及时结束：第二条路线重复晋升失败，随后又规划，最终用户取消。此次修复把求解阶段首次有效 flag 候选作为调度结束条件，停止竞争路线、回传候选并保留显式复核；旧 confirmed 结果不因最终取消被隐藏。

新增主会话受理与阶段卡片、sapper_control 与 steer/continue/wp/retry 命令。运行中调整方向会排空旧路线再自动续跑，显式取消撤销排队方向；结束后甚至原项目 completed，也能用关联新图写 WP 或重新取证纠错，保留原图与证据。WP 阶段不因引用历史 flag 早停。

验证：150 项测试（13 文件，其中 48 项真实 SDK 编排/面板测试）、类型、双端构建、冻结锁文件离线安装与官方兼容/包检查通过。最终构建另跑 7 项真实宿主回归，覆盖客户端窗口发起 WP、flag 早停与竞争路线回收、主会话调整方向、completed 后 WP/纠错、显式独立复核、排队取消和取消后部分结果回传。WP 用例实际写出文件并由另一子会话读取。真实 test3 仅作只读检查，没有重跑目标或更改其数据。

交付 `sapper-dsh-0.1.0-alpha.12.tgz`，SHA256 `8833d449883bc09b1550fd57b3fa2c0648f255f7ddd1544910d4c76afd51b517`，副本已放入 Windows `D:\BaiduSyncdisk\sapper移植`。DSH 0.2.1-rc.2 隔离 profile 安装退出 0，无兼容豁免，安装后宿主与本地构建哈希一致（`ff7ad30d5355d225db4b0c4e47a80b0cf60e472147acfcbf8ef8fe73f1bdf0bb`）。日常 desktop profile 未修改。浏览器与确定性模型回归不代替在线模型内容质量验收。
