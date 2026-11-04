# 任务面板与普通工作区

适用版本：0.1.0-alpha.8，DSH 0.2.1-rc.2。

## 日常使用

1. 在 DSH 打开任意已有目录的普通对话，选择可用模型和会话权限。
2. 展开输入框附近的 **Sapper 任务**；插件设置页也有同一任务面板，自动列出打开的工作区会话。
3. 输入明确目标，点击 **发起任务**。插件自动建立任务图、登记用户目标与目录上下文，并启动 reason → explore → verify。
4. 查看运行阶段、事实与已验证数量、待推进意图和终止原因。关闭面板不会取消后台任务；**取消任务**会停止并回收子会话。
5. 预算结束或可重试失败后点击 **继续当前任务**。任务历史里的 **打开任务**可切换并继续未完成任务；已完成任务只打开查看。

也可直接输入 `/sapper start 检查本项目的构建并记录结果`。已有手工图继续支持 `/sapper run` 和原工具接口。

不需要创建专用测试工作区、预置 sample.txt、手工 init、源事实或意图。选择当前已打开会话是为了沿用它的目录、模型、工具和权限。没有打开会话时，先打开 DSH 的普通对话即可。

## 存储与兼容

新任务保存到当前目录的 `.sapper/tasks/t-<UUID>/`，每个任务仍使用 Python 兼容的 project/facts/intents/hints/runs 文件。`.sapper/tasks/index.json` 原子登记任务列表和当前任务。图工具、上下文注入、命令和编排都读取所选任务。

旧 `.sapper/project.json` 不迁移、不覆盖，在面板显示为原任务（ID `legacy`）。旧失败运行和 ready 意图可以直接继续，运行历史保留。新建任务不污染旧任务的事实、计数器和目标。

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
