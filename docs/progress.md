# 项目进度

更新：2026-11-03（Asia/Shanghai）。当前 alpha.6，DSH 0.2.1-rc.2。

**M0/M1 已验收；用户要求继续 M3，并与 M2 统一验收。M2/M3 工程已实现，尚未登记桌面验收通过。**
[阶段跟踪 issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 |
| --- | --- | --- |
| M0 | 用户已验收 | 桌面安装/设置/工具/目标摘要 |
| M1 | 用户已验收 | 事实图、六个基础工具、文档/归属、flag、本地锁/事务恢复 |
| alpha.4 权限修复 | 用户反馈正常 | 普通图维护连续自动执行 |
| alpha.5 完全权限修复 / M2 | 已实现，合并验收 | 完全权限确认门、frontier/历史/预算、recall/离线 KB、只读命令 |
| alpha.6 / M3 | 已实现，M2/M3 统一桌面验收待完成 | 真实子代理、证据门、运行记录、预算/并发/模型/取消/恢复 |
| M4 | 未开始 | 完整设置页、诊断 RPC、图预览 |
| M5 | 未开始 | 干净环境、迁移与最终发行验收 |

## 本轮交付

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

## 验证证据

- 类型检查、116 项测试（12 文件）与双端构建通过；其中 20 项使用真实 DSH
  AgentLoop/SubagentRuntime/ToolRuntime 和确定性本地模型，另测真实 CommandRuntime。
- 正常链路、无证据/伪造证据/复核失败不写事实、上下文隔离、门禁绕过拒绝、跨调用
  maxVerify、并发/步数/超时、取消回收、只读/受限审批/完全权限、权限撤销与恢复通过。
- 固定上游 Python Store/frontier/history、两个独立 Node 写者、打包 VM/KB 与官方
  兼容门禁继续保留；SDK peers 均与运行时一致，不授予版本豁免。
- 冻结锁文件离线安装通过；Windows DSH NEXT 自带安装器在隔离 DSH_HOME/profile
  完成 alpha.5 → alpha.6 升级，并用唯一归档路径重装最终包，INSTALL_EXIT_CODE=0，无版本豁免。
  最终归档及已安装 host 的 SHA256 均逐项核对一致，日志 dist/validation/windows-upgrade-alpha6.log。
- 跨平台 CI 为 Ubuntu/Windows × Node 22/24，本轮结果见 Actions 与 issue #1。

确定性模型证明机制与接口，未调用在线模型/真实目标；真实模型判断与桌面交互按
[统一指南](m2-m3-validation.md) 验收。现有 desktop profile 不由本轮脚本修改。

## 用户验收与历史发布

M0：alpha.2 安装、状态变化与目标摘要已由用户确认。M1：alpha.3 图维护、确认/领取、
原子结案、重复结案与完整性结果由用户确认。alpha.4 用户反馈功能正常，同时要求
完全权限默认通过审批；alpha.5 实现该要求和 M2。最新用户要求继续 M3，与 M2 一起
验收，不能把上述旧反馈当作 alpha.6 的验收证据。

历史 alpha.4（65 项）和 alpha.5（96 项）的 Ubuntu/Windows × Node 22/24 CI 全绿，
Windows 隔离 profile 完成 alpha.3 → alpha.4 → alpha.5，无版本豁免。旧 tgz 保留。
alpha.5 SHA256：7de366f7e21e733efc955da4186a57a927619f965e0b1e43ce8b9983dcdf42d6。
历史日志在 dist/validation；兼容与权限事故经验见 lessons-learned.md。

下一步按统一指南一起验收 M2/M3，再进入 M4。当前只有 workspace 存储，global 和
普通聊天自动触发仍预留；TS/Python 写者须顺序交接，Python 不提供本插件的 M3 门禁。

本机安装包：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.6.tgz`，附 SHA256 文件。
仓库 dist 与 Windows 同步目录内容一致；包含 56 条 KB、3 个角色 prompt，无 Python/测试代码。
SHA256：`4d67677032d7410a6cbb5d54d9b024ea01883059927b3843e228a9bc0ae5bb00`。
