# M3 编排契约

alpha.7，DSH 0.2.1-rc.2。M2/M3 的桌面交互按 [统一指南](m2-m3-validation.md) 验收。

## 入口与运行记录

| 入口 | 行为 |
| --- | --- |
| sapper_dispatch mode=run / /sapper run | 显式启动后自动 reason → explore → verify，按预算推进 |
| mode=reason | 独立只读子代理提出 0–4 条意图，编排器校验依赖/重复后写入 |
| mode=explore, intent_id | 执行该意图，返回并保存待复核候选，释放领取，不新增事实 |
| mode=verify, intent_id, run_id | 从指定运行读取候选，独立复核；同一候选的次数跨调用累计 |
| mode=status / /sapper runs | 最近 20 个运行摘要；status 带 run_id 才展开完整证据记录 |
| mode=recover, run_id | 原执行者停止后恢复遗留 running 记录，释放意图、留下 hint，不晋升候选 |

需要已有健康工作区图和源事实；不自动把 goal 编造为事实。reason 若没有源事实或
新任务可提出，返回空列表并停止。orchestration.auto 仍是普通聊天自动触发的预留项，
不会接管每轮聊天；显式 run 已包含自动循环，无需每一步确认。

运行保存在 `.sapper/runs/r001.json`，使用现有 run 计数器、队列、LOCK 和事务日志。
候选/复核证据、子会话 ID、尝试次数、结果事实 ID 和终止原因可追溯；
children 还记录启动时的 tools、external_tools 与 max_output_tokens，失败启动的
能力快照不表示已经发出模型请求。它们与图数据
一样可能包含敏感的工具输出，按原工作区文件保护。默认返回摘要，不把所有证据自动
塞进父会话；用户显式读取完整运行或 doc 才展开。

## 真实 DSH 接口

使用 ctx.subagents.startActivation，provider=spawn、delivery=caller，预留 childId，
请求 outputSchema、agentOptions 和 maxDepth。只接受不继承父对话且支持这些能力的
本地提供者；服务缺失或能力不符时在建运行记录前报错，不回退到普通文本“模拟代理”。

通过 awaited agent/created 按实际继承链安装工具限制（含 preset 祖先作用域），
不要求外部工具在全局注册，并与父会话当前可见工具取交集；tools.guard 保证执行约束。子会话单独声明 native 呈现，
父会话/preset 的 PTC 模式与其他限制保持原样；保留
DSH scoped structured_output。子会话不再次注入 Sapper 全图，verify 不接收 explore
的推理/对话或无关事实。三个角色 prompt 实际从包内 resources/prompts 加载。

DSH spawn 继承父会话当前模型和委派权限策略。models.reason/explore/verify 默认
inherit；可设 model 或 provider:model。未知路由由 DSH 报错，不偷偷换模型。
DSH 的子代理工具、事件和生命周期仍正常可观察，不需要第三方 CLI。

## 证据与晋升

1. reason 只读图，返回有已有事实依赖、描述与成功判据的意图。批次校验先于写入。
2. explore 只推进已领取意图，返回 title/description/kind 与证据引用；不调用图写入工具。
3. 新子代理使用服务端签发的 receipt_id 引用本次子会话真实成功的白名单外部工具输出。
   插件观察 tools/result 后注入回执；模型只返回 ID，插件保存原 call_id、tool、输出摘要和 SHA256。
   模型无需复制路径或换行。回执按子会话隔离，历史 API 的 exact-excerpt 契约仅兼容保留。
   缺证据、虚构 ID、错误调用、纯模型文字都不能成为候选证据。
4. verify 是新子会话，只获目标、意图/成功判据、候选与证据。通过需要它自己成功调用
   外部工具并提供可核对输出；不能复用 explore 的 call_id 冒充独立工具证据。
5. verified=true 且证据通过检查后，编排器原子写 confirmed 事实、意图结案与运行结果。
   事实 doc 保存证据，verification 记录运行与两个不同子会话 ID。父会话也不能用
   普通 fact(source_intent)/intent conclude 绕过 M3 管理的意图。
6. 无证据或复核失败：不新增结果事实，意图重新开放，写 hint 和 last_failure，后者
   参与 sapper_recall。真实复核失败时 run 可在剩余预算内 reason 新路径，同次 run 不重试原意图。
   缺少外部取证工具在模型请求前报 SAPPER_M3_TOOL_UNAVAILABLE；max-tokens、超时
   或未完成结构化结果终止本轮，不追加 reason 重试。

普通 M1 fact 是 observed，不自动变为 confirmed。requires_confirmation 是授权门，
与证据状态不同。完全权限只自动满足授权门，不替代 independent verify。

reason 可在提议中给 completes_goal=true；仅当 verifier 也给 goal_achieved=true，
晋升事务才额外建立终态意图并完成项目。否则即使候选已确认，项目仍保持 active。
这是模型基于独立工具证据的复核机制，不是语义正确性的形式化证明。

## 预算与工具

| 配置 | 默认 | 范围/含义 |
| --- | --- | --- |
| maxSteps | 24 | 一次 run 最多处理的意图数；reason 周期也至多此数 |
| maxExplore | 20 | 一次 run 最多 explore 次数 |
| maxVerify | 2 | 同一候选跨调用的复核上限，持久化于意图 |
| concurrency | 2 | 同时推进的意图流水线；每条流水线最多一个活跃子会话 |
| timeoutMin | 45 | 每子会话含启动/执行的墙钟分钟数 |
| runTimeoutMin | 90 | 整轮墙钟分钟数 |
| budgetMode | adaptive | 有新证据时自动延长；fixed 使用固定步数 |
| maxChildSteps | 24 | 初始步数，包含结构化提交；reason 不自动延长 |
| maxChildStepsCeiling | 128 | explore/verify 自动延长上限（不会缩减更高的显式初始值） |
| maxOutputTokens | 16384 | 每次子会话模型请求的输出 token 上限 |
| requireApproval | true | workspace-write 的启动审批；完全权限自动通过 |

自动预算在成功外部工具调用的工具名、参数或输出发生变化时视为新进展，每次增加初始步数（至少 8 步），直至上限。无新证据则进入收尾，最后最多两步只允许结构化提交。运行记录保存实际步数、当前额度、延期次数和子代理状态。再次 run 优先复核尚未完成复核的已存候选，复核次数仍持久化约束；已明确拒绝的候选不会这样重试。

reason 输入采用 M2 的 frontier-history 共用字符预算，长 doc 不自动展开。探索只
发送该意图依赖，复核只发送该候选。外部工具白名单：exploreTools 默认为 read/glob/
grep/bash/pwsh/web_search/web_fetch；verifyTools 默认为 read/glob/grep/bash/pwsh。
未安装或不在父会话工具范围内的工具不会因白名单而获得注册或权限。禁止通过该配置
放开 Sapper 图写入、run_code 传输与相邻代理通信；所有实际调用仍受 DSH 其他策略。旧显式 4096 预算不被升级覆盖，错误信息会显示实际
maxOutputTokens。预算不足可以调整；缺工具必须修复 preset/白名单。

角色过滤限制工具入口，不是额外的 OS 沙箱；shell 拥有 DSH 会话实际授予的能力。
prompt 要求不修改 .sapper，图/KB/目标响应均不能授予外部执行权限。任务范围和
命令安全仍由原 DSH 权限体系约束，详见 permissions.md。

## 取消、恢复与边界

父工具取消、子会话超时/超步数、配置变动、权限撤销和插件禁用/卸载会停止并 dispose
精确 activation；清理等待子会话退出。取消工具的最终 UI 结果可能是 aborted，应再
查询磁盘状态，不能仅依赖父工具返回文本判断清理是否完成。

本地图失败/取消清理仍受当前权限与配置约束，失去写权限时不强写记录。此时可能
留下 running/claimed；恢复权限且原执行者已退出后，显式 mode=recover。它不能
重启旧子代理或自动晋升候选。同进程当前活跃运行禁止 recover。

同一插件实例每工作区只允许一个活跃编排；队列/LOCK 和领取事务保护图写入，预算
不是多个独立 DSH 进程之间的全局配额。跨进程/异常退出后仍需按真实执行者状态恢复。
TS/Python 写锁不互通，必须顺序交接。已提交事务遵循原存储恢复规则。

自动测试使用真实 AgentLoop/SubagentRuntime/ToolRuntime 与确定性本地模型适配器，
证明接口、生命周期和状态机。没有在测试中调用在线模型或真实目标；在线模型的实际
工具选择、语义判断与桌面交互按统一指南验收。
