# DSH SDK 核对记录

日期：2026-11-03。目标：DSH NEXT 0.1.5-rc.1。

核对来源为本地 DSH 包缓存、npm 同版本包的实现与类型声明。没有复制 DSH 内部
代码。版本固定在 package.json 与 pnpm-lock.yaml；不依赖 Windows 应用的内部
Python/uv 路径。

| 契约 | 已核对的来源 | 骨架采用方式 |
| --- | --- | --- |
| Cordis apply / inject / effect | `@deepseek-ai/cordis@4.0.2` | 宿主 ESM 导出 `apply`、`Config`、`inject` |
| 工具 | `dsh-tools/lib/types/schema.d.ts` | `defineTool({parameters, output: {schema, render}, execute})` |
| pre-step | `dsh-agent/lib/types/runtime-types.d.ts` | payload 包含 agent/messages/turn/step/signal，next 返回 enter/reject |
| 消息来源 | `dsh-llm/lib/types/message.d.ts` | `createUserMessage` + plugin snapshot + sections |
| 宿主设置 | `dsh-settings/lib/types/index.d.ts` | register('sapper', schema, {base, validate})，热读 scope.get() |
| 关闭工具 | `dsh-tools` 的 register | 保存 disposer，关闭后注销；重新打开再注册 |
| 客户端包入口 | `dsh-client-modules/README.md` 和 `lib/index.js` | 顶层 `exports['./client']`，不是 `dsh.client.exports` |
| 客户端格式 | `dsh-client-modules/README.md` 的 Lazy-CJS model | classic script 只注册 factory，require 在 materialize 时执行 |
| 插件卡片 | `dsh-client-ui-settings-plugins/lib/client.js` | keyed slot `settings.plugin.item`，key 为 `sapper` |
| 独立设置 tab | 同上 + plugin-inventory 的客户端实现 | `settings.plugins.tab`，id 为 `sapper` |
| 客户端设置 | `dsh-client-ui-settings/lib/client.js` | settingsScope.bind({namespace:'sapper'})，getSnapshot/subscribe/set |
| 通用 CLI 的 desktop 限制 | `@deepseek-ai/dsh` 的 README 和 `lib/bin.js` | 通用 CLI 拒绝管理 Electron 保留的 desktop profile |
| 桌面专用 CLI | 已安装 DSH NEXT 2.0.19-next 的 `lib/main.js`、`lib/desktop-cli.js` | 应用菜单“打开 DSH 终端”，专用 shim 设置默认 profile 并调用 runCli({manageDesktopProfile:true}) |

安装说明修正：此前遗漏了“必须从桌面应用打开专用终端”的前提。桌面终端欢迎
信息明确提供 `dsh plugin add <package>` / `dsh plugin remove <package>`，修改
后重启桌面应用。该入口已从安装程序代码核对，实际安装验收仍待完成。

目前宿主可对照 npm 发布的真实 `.d.ts` 编译。浏览器只涉及少量服务方法，采用
`src/dsh-adapter/client.ts` 的窄结构契约隔离客户端与宿主 Context 的类型扩展；
尚需 M0 在 Windows WebView 中确认。

## 尚不能据此判定通过

- VM 中 lazy-CJS 和卡片注册成功，不等于 DSH NEXT 已实际发现并激活插件。
- 内存 provider 的设置热更新通过，不等于 Windows settings.yaml 与 WebView
  transport 已联调。
- 当前 settingsScope.set 的 SDK 实现可能在写失败后自动恢复镜像；完整的字段
  错误和并发冲突展示仍属于 M4，本骨架只提供基础的加载/保存状态。
- Node/Windows CI 是跨平台单测，不替代真实 DSH NEXT 桌面验收。
- subagent/workflow、工具审批和数据目录 API 只列为后续待核对项，本轮未接入。
