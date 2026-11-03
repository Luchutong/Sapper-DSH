# DSH SDK 核对记录

日期：2026-11-03。当前目标：DSH **0.2.1-rc.2**，插件 **0.1.0-alpha.6**。

版本依据是当前 Windows 安装版 app.asar 内实际加载的包元数据，并与 npm 同版本
包的实现和类型声明对照。旧 ~/.cache/pkg 中的 0.1.5-rc.1 不能代表当前桌面。
Cordis 为 4.0.5，Schemastery 为 3.18.5。原计划 HTML 保留为历史快照，具体适配
以本文件和代码为准。事故记录见 [lessons-learned.md](lessons-learned.md)。

| 契约 | 当前实现 / 来源 | 插件采用方式 |
| --- | --- | --- |
| 安装兼容性 | dsh-app-boot 的 evaluatePluginCompatibility | 空豁免表检查；CI 和 prepack 必须通过 |
| Cordis | 4.0.5 的 apply / inject / effect | 宿主 ESM；工具和 Agent 服务为必需，Settings 为可选 |
| 工具 | dsh-tools 的真实 defineTool 声明 | 参数 schema、输出 schema/render、execute |
| 文件写权限 | dsh-sandbox-policy 的 SandboxPolicyService.resolve | 每次读取会话 mode / workspaceRoot，提交前再次核对；只读或服务缺失时拒绝 |
| 额外审批 | tools/pre-execute / PreToolDecision.ask | 完全权限自动通过自身确认门；workspace-write 的 confirm/always 才 ask，其他策略决定保留 |
| M3 子代理 | dsh-subagent 0.2.1-rc.2，安装版 ASAR 与 npm 同版本核对 | startActivation：spawn / childId / delivery=caller / outputSchema / agentOptions / maxDepth；持有并 dispose 精确 activation |
| 角色约束 | agent/created + tools.restrict / tools.guard | 创建公告后、首次 prompt 前安装限制；structured_output 保留，子会话不注入 Sapper 全图 |
| 命令 | dsh-commands 的 CommandRuntime.register / CommandDefinitionId | 可选 commands 注入；查询直接返回；run 经 tools.execute 启动编排；禁用/卸载释放注册 |
| 单调守卫 | ctx.tools.guard | 绑定配置/工作区/会话权限快照；提交前重查，阻止权限撤销或插件关闭后的未提交写入 |
| pre-step | dsh-agent 的 runtime-types | payload 含 agent/messages/turn/step/signal，next 返回 enter/reject |
| 消息来源 | dsh-llm 的 MessageSourceMap | 扩展 producer kind=sapper-dsh，form=snapshot，带 sections |
| 配置 | Schemastery volatile + Cordis Loader | Config.volatile()；每次从 config.get() 读取当前值 |
| 更新通知 | loader/volatile-update | 更新工具注册；不依赖已删除的 settings/updated |
| 宿主表单 | dsh-settings 的 SettingsForms | 自动从 id=sapper 的 Loader 条目派生，不调用 register |
| 页面策略 | SettingsForms.configure | 自带客户端页面，auto=false；由可选注入子级持有 effect |
| 持久化 | DSH config-editor | 当前 profile 的 Cordis patch，替代旧 settings.yaml namespace |
| 客户端表单 | dsh-client-ui-settings/client 的 ConfigForms/ConfigForm 类型 | configForms.get('sapper')，getSnapshot/subscribe/set |
| 表单返回值 | ConfigForm.set / mutate -> Promise<boolean> | 顶层启用字段用 set，嵌套写入策略用 mutate 路径数组；false 显示拒绝保存 |
| 页面生命周期 | configForms.whileServed | 仅在宿主暴露 sapper 配置时显示页面，取消后释放注册 |
| 插件卡片 | 当前桌面与官方 companion 的 plugins.item | id=sapper；summary 为短描述，其他视图为表单 |
| 独立设置页 | settings.section | id=sapper，位于“设置 → Sapper” |
| 客户端产物 | dsh-client-modules 的 lazy-CJS | 顶层 exports['./client']；classic script 只注册 factory |
| 安装入口 | 桌面 main.js / desktop-cli.js | 应用菜单打开 DSH 终端，再执行 dsh plugin add；专用 shim 允许管理 desktop |

客户端使用真实 SDK 的 ConfigForm 类型收敛读写接口，不再手写旧版 Promise<void>
契约。浏览器产物仍只外部引用 React 与 JSX runtime；宿主 SDK 由 DSH 提供。

## 验证范围

- 测试使用真实 Cordis、Loader、SettingsForms 和测试配置编辑器，覆盖 volatile
  更新不重启 fiber、关闭/开启、修订号冲突、图读取与自定义消息来源。
- 官方检查器拒绝旧包声明、接受新声明；未测旧 SDK 或未知下一版本不会被宣称兼容。
- 打包检查验证 host import、lazy-CJS、当前客户端插槽与 KB 资源。
- M2 使用真实 CommandRuntime 测试注册、执行事件、取消、禁用/重开/卸载。
  dsh-commands 为同版本 peer；attachment/session/typert-protocol 为真实命令测试的开发依赖。
- Windows DSH NEXT 自带 desktop-cli 已在独立 DSH_HOME / 临时 profile 中安装
  alpha.2，并完成 alpha.3 → alpha.4 → alpha.5 → alpha.6 升级（退出码 0，dependencies 与 bundles 已登记，无版本豁免）。
- M0/M1 与 alpha.4 功能获用户确认。alpha.5 完全权限覆盖自身确认门并交付 M2，
  新策略通过真实 ToolRuntime / SandboxPolicyService 自动测试；桌面回归按 M2 指南验证。
- M3 遵守 subagents.resolveMaxDepth() 全局上限，不按调用者深度自行扩大。
- M3 使用真实 AgentLoop/SubagentRuntime/Spawn provider 与确定性模型适配器完成集成回归，
  包含创建、结构化结果、子代理回收、取消/权限撤销、独立证据与目标终态。无需 workflowEngine。
- subagent 的 spec.signal 仅覆盖启动取消；发布后的超时/撤销必须调用 activation.dispose，
  不能只 abort 启动 signal 后等待 result。全局数据目录仍属于后续阶段。
