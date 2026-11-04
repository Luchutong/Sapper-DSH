# 任务面板与普通工作区

适用版本：0.1.0-alpha.10，DSH 0.2.1-rc.2。

## 日常使用

1. 在 DSH 打开任意已有目录的普通对话，选择可用模型和会话权限。
2. 展开输入框附近的 **Sapper 任务**；插件设置页也有同一任务面板，自动列出打开的工作区会话。
3. 输入明确目标，点击 **发起任务**。插件自动建立任务图、登记用户目标与目录上下文，并启动 reason → explore → verify。
4. 查看运行阶段、事实与已验证数量、待推进意图和终止原因。关闭面板不会取消后台任务；**取消任务**会停止并回收子会话。
5. 预算结束或可重试失败后点击 **继续当前任务**。任务历史里的 **打开任务**可切换并继续未完成任务；已完成任务只打开查看。

也可直接输入 `/sapper start 检查本项目的构建并记录结果`。启动命令立即返回后台任务编号，输入框随即恢复编辑；不会等模型整轮执行结束。已有图用 `/sapper run` 后台继续。原 `sapper_task` / `sapper_dispatch` 工具仍保持等待执行结果的语义。

运行中可用 `/sapper job` 查看当前后台任务、阶段、已验证事实与失败原因，`/sapper runs` 查看运行记录；`/sapper cancel` 立即请求取消，随后状态从 `cancelling` 变为 `cancelled`。清理结束前不能重复发起任务。普通聊天与状态查询可继续使用。

命令启动的任务与面板共用后台管理器，会自动展开对话中的 Sapper 任务面板。运行时仍可编辑下一条目标，发起按钮在当前任务结束前保持禁用，避免误建重复任务。

不需要创建专用测试工作区、预置 sample.txt、手工 init、源事实或意图。选择当前已打开会话是为了沿用它的目录、模型、工具和权限。没有打开会话时，先打开 DSH 的普通对话即可。

## 存储与兼容

新任务保存到当前目录的 `.sapper/tasks/t-<UUID>/`，每个任务仍使用 Python 兼容的 project/facts/intents/hints/runs 文件。`.sapper/tasks/index.json` 原子登记任务列表和当前任务。图工具、上下文注入、命令和编排都读取所选任务。

旧 `.sapper/project.json` 不迁移、不覆盖，在面板显示为原任务（ID `legacy`）。旧失败运行和 ready 意图可以直接继续，运行历史保留。若旧图是不完整的 M0 预览或无法读取，面板显示诊断，新任务的启动与状态监控不受未选中的旧图影响。新建任务不污染旧任务的事实、计数器和目标。

自动登记的“任务上下文”只是用户要求和实际会话目录，属于 observed，不是目标已成立的证据；confirmed 仍需 explore 和另一个 verify 子会话分别成功调用外部工具。

面板打开、刷新、状态查询都只读。启动操作经 DSH ToolRuntime 执行，完全权限自动通过 Sapper 自身确认，受限模式保留原政策，只读模式返回失败原因。面板 RPC 仅供本机 owner 使用，操作绑定实际会话，不接受客户端提交存储路径或权限。

## 本次测试与边界

包含真实 DSH AgentLoop、SubagentRuntime、ToolRuntime、主客端 Typert Gateway 测试；本地确定性模型用于验证流程和接口，不代表在线模型的任务判断质量。桌面安装后的实际模型效果仍需在真实任务中观察。

浏览器探针使用构建后的 lazy-CJS 客户端、React、真实宿主 Gateway 和子代理流程，检查输入目标、点击启动、自动创建第二个任务、独立复核和页面错误；截图保存在本地 `dist/validation/panel-desktop.png`。可在安装 Playwright Chromium 后运行：

```sh
corepack pnpm build
SAPPER_BROWSER_PROBE=1 corepack pnpm exec vitest run tests/orchestration.test.ts -t 'Typert Gateways'
```

高级配置完整表单、可视化图编辑器与普通聊天自动触发仍未作为本版功能开放。子代理预算及工具可见性继续由当前 DSH preset 和 Sapper 配置约束，失败不会写入伪造 confirmed 事实。

## alpha.9 首次命令启动阻塞的经验

真实 `test1` 记录显示旧命令在后台子代理已产生 confirmed 事实时，仍未写入 `command/done`。两次命令分别等待约 58 秒、161 秒才返回。DSH 新会话输入器在命令提交期间处于 `submitting`，因此保持只读，表现为欢迎页无反应。

alpha.10 将命令改为共享后台管理器的快速受理操作，任务使用独立取消信号，通过原 ToolRuntime 执行；请求返回或会话输入器释放不取消任务。模型/文件权限检查保留，异步失败由 job/面板展示。命令取消会等待实际工具体和子会话清理完成后才标为终止。

补充回归使用同版本 DSH 浏览器产物中实际的 SubmitMachine，与真实 CommandRuntime、ToolRuntime 和阻塞的子代理联动，检查命令已结算且输入器回到 `plain` 时任务仍运行，并验证可查询、拒绝重复提交、取消及只读失败后重试。此前只验证工具和独立面板，漏掉了新会话命令提交的输入器生命周期。
