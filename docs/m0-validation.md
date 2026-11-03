# M0 验收检查表

## 本地自动验证

- [x] 安装同版本 DSH SDK，编译宿主代码。
- [x] 真实 Cordis + Loader + SettingsForms 加载插件。
- [x] 官方兼容检查器复现旧包拒绝，并接受 alpha.2 / DSH 0.2.1-rc.2，未启用豁免。
- [x] 只注册 `sapper_status`，读取时不创建工作区文件。
- [x] pre-step 注入带来源和不可信声明，重复轮次不累积本插件 snapshot。
- [x] volatile Config 热更新后注销/恢复工具；卸载后表单不再出现并清理 listener。
- [x] 损坏 project 文件不改原文件，不中断普通对话。
- [x] 构建宿主 ESM 和客户端 lazy-CJS。
- [x] 在 VM 中 materialize 打包后的客户端并注册 plugins.item/settings.section；不触发设置写入。
- [x] 客户端正确处理 configForms 写入返回 false，不显示为保存成功。
- [x] 客户端产物不请求 Node 模块，仅请求宿主共享的 React。
- [x] 56 条 KB 与上游许可进入包。

## Windows 隔离安装验证

- [x] 2026-11-03：通过安装版 DSH NEXT 自带 desktop-cli，在临时 DSH_HOME 的
  `sapper-compat` profile 安装 alpha.2，退出码 0；dependencies 与 bundles 已登记。
- [x] 使用桌面自带 Node/pnpm，没有开启 exact-version exemption，也没有修改现有
  desktop profile。证据：`dist/validation/windows-install-alpha2.log`（本地产物）。

这证明当前安装器接受新包；不替代下列 desktop 激活和界面交互门禁。

## Windows DSH NEXT 0.2.1-rc.2 手工门禁

这些项目尚未完成，M0 仍为进行中；按计划书，在全部通过前不宣布进入 M1。

- [ ] 从 DSH NEXT 的“打开 DSH 终端”进入桌面专用 CLI，核对欢迎信息中的 profile 和环境。
- [ ] `dsh --version` 为 0.2.1-rc.2；不使用桌面应用版本号或旧包缓存代替运行时版本。
- [ ] 在该终端执行 `dsh plugin add <tgz 的 Windows 路径>`，保存安装日志；系统通用 CLI 不支持 desktop。
- [ ] 重启后确认 host entry 激活，client module 被发现，无 factory/module 错误。
- [ ] 插件页出现 Sapper 卡片，“设置 → Sapper”配置页可打开。
- [ ] 只打开页面不改写 profile 配置。
- [ ] 切换启用字段，profile Cordis patch 仅修改 sapper 条目的配置。
- [ ] 重启后字段值保留。
- [ ] 在含空格和中文的测试工作区中调用 sapper_status，状态正确。
- [ ] 使用一份测试 project.json，确认 pre-step 的目标摘要来源可识别。
- [ ] 关闭插件后下一轮不含摘要，sapper_status 从工具列表消失。
- [ ] 移除插件后无活动 hook 或工具残留。

请在 `docs/progress.md` 记录 DSH/Windows 版本、日期与证据路径；不要在提交中包含
真实模型凭据、会话内容或个人 profile 设置。

具体命令、测试 project.json 与预期输出见 [验证指南](validation-guide.md)。
