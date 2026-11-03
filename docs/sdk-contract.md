# DSH SDK 核对记录

日期：2026-11-03。当前目标：DSH **0.2.1-rc.2**，插件 **0.1.0-alpha.2**。

版本依据是当前 Windows 安装版 app.asar 内实际加载的包元数据，并与 npm 同版本
包的实现和类型声明对照。旧 ~/.cache/pkg 中的 0.1.5-rc.1 不能代表当前桌面。
Cordis 为 4.0.5，Schemastery 为 3.18.5。原计划 HTML 保留为历史快照，具体适配
以本文件和代码为准。事故记录见 [lessons-learned.md](lessons-learned.md)。

| 契约 | 当前实现 / 来源 | 插件采用方式 |
| --- | --- | --- |
| 安装兼容性 | dsh-app-boot 的 evaluatePluginCompatibility | 空豁免表检查；CI 和 prepack 必须通过 |
| Cordis | 4.0.5 的 apply / inject / effect | 宿主 ESM；工具和 Agent 服务为必需，Settings 为可选 |
| 工具 | dsh-tools 的真实 defineTool 声明 | 参数 schema、输出 schema/render、execute |
| pre-step | dsh-agent 的 runtime-types | payload 含 agent/messages/turn/step/signal，next 返回 enter/reject |
| 消息来源 | dsh-llm 的 MessageSourceMap | 扩展 producer kind=sapper-dsh，form=snapshot，带 sections |
| 配置 | Schemastery volatile + Cordis Loader | Config.volatile()；每次从 config.get() 读取当前值 |
| 更新通知 | loader/volatile-update | 更新工具注册；不依赖已删除的 settings/updated |
| 宿主表单 | dsh-settings 的 SettingsForms | 自动从 id=sapper 的 Loader 条目派生，不调用 register |
| 页面策略 | SettingsForms.configure | 自带客户端页面，auto=false；由可选注入子级持有 effect |
| 持久化 | DSH config-editor | 当前 profile 的 Cordis patch，替代旧 settings.yaml namespace |
| 客户端表单 | dsh-client-ui-settings/client 的 ConfigForms/ConfigForm 类型 | configForms.get('sapper')，getSnapshot/subscribe/set |
| 表单返回值 | ConfigForm.set -> Promise<boolean> | false 显示拒绝保存，异常显示传输失败 |
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
- Windows DSH NEXT 自带 desktop-cli 已在独立 DSH_HOME / 临时 profile 中安装
  alpha.2 成功（退出码 0，dependencies 与 bundles 已登记，无版本豁免）。
- 当前仍需 desktop profile 的激活、WebView 加载、字段持久化及停用验收。
  兼容门禁通过、Node CI 通过和桌面交互通过是不同的证据。
- subagent/workflow、写工具审批和全局数据目录仍属于后续阶段。
