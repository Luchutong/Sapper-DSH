# test3 运行检查与修复依据

检查日期：2026-11-04，Asia/Shanghai。只读检查 Windows 同步目录中的 test3 图；没有访问目标、重跑任务或修改该图。

任务 `t-f0c77cde-25e8-40c5-bc1b-b13ba8cd1afe`，运行 r001：12:18:37 启动，12:20:07 因用户取消结束，约 90 秒。project 仍 active，事实 2、意图 2、hint 1。

实际 flag：`CTF2{169733d4-2150-47f3-9608-11fb9dba2a1b}`。

- i001 explore 在 12:19:15 提交 flag 候选；独立 verifier 于 12:19:31 完成，f002 为 confirmed，证据引用不同子会话的成功 pwsh 输出。不是本次检查推断或手工补写的 confirmed。
- i001 的 completes_goal 没有设为 true；verifier 明确因此没有报告 goal_achieved。旧调度器于是保留 active，并等待第二条路线。
- i002 也找到同一 flag 并独立复现，于 12:19:54 晋升时因“候选 flag 已有本地记录，不重复晋升”失败，留下 h001。
- 12:19:54 又启动 reason，直到 12:20:07 用户取消。最终 run=cancelled，不能据此推断 flag 未找到。

alpha.12 求解流程在首次有效 flag 候选出现后即停止竞争路线，保存并回传主会话；未复核结果明确为候选。已确认 flag 阻止后续无关探索，不依赖模型是否在最初的侦察意图上猜中 completes_goal。普通候选的证据门、显式独立复核和平台权限保留。

主会话现在显示受理、阶段、方向变更和最终结果。取消后报告仍读取已持久化的部分结果，避免丢失已找到的 flag。新增 steer / continue / wp / retry 与 sapper_control，允许在运行时换方向、结束后在关联的新阶段写 WP 或纠错；原始图不被重写。详细用法见 [任务窗口](task-panel.md)。
