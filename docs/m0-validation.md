# M0 验收检查表

## 本地自动验证

- [x] 安装同版本 DSH SDK，编译宿主代码。
- [x] 真实 Cordis + 内存 settings provider 加载插件。
- [x] 只注册 `sapper_status`，读取时不创建工作区文件。
- [x] pre-step 注入带来源和不可信声明，重复轮次不累积本插件 snapshot。
- [x] 禁用后注销工具并清除当前注入；卸载后清理 namespace 与 listener。
- [x] 损坏 project 文件不改原文件，不中断普通对话。
- [x] 构建宿主 ESM 和客户端 lazy-CJS。
- [x] 在 VM 中 materialize 打包后的客户端并注册卡片/tab；不触发设置写入。
- [x] 客户端产物不请求 Node 模块，仅请求宿主共享的 React。
- [x] 56 条 KB 与上游许可进入包。

## Windows DSH NEXT 0.1.5-rc.1 手工门禁

这些项目尚未完成，M0 仍为进行中；按计划书，在全部通过前不宣布进入 M1。

- [ ] 在测试 profile 安装 `dist/sapper-dsh-0.1.0-alpha.1.tgz`，保存安装日志。
- [ ] 重启后确认 host entry 激活，client module 被发现，无 factory/module 错误。
- [ ] 设置 → 插件出现 Sapper 卡片和 Sapper tab。
- [ ] 只打开页面不创建或改写 settings.yaml。
- [ ] 切换启用字段，settings.yaml 仅改变 sapper 命名空间。
- [ ] 重启后字段值保留。
- [ ] 在含空格和中文的测试工作区中调用 sapper_status，状态正确。
- [ ] 使用一份测试 project.json，确认 pre-step 的目标摘要来源可识别。
- [ ] 关闭插件后下一轮不含摘要，sapper_status 从工具列表消失。
- [ ] 移除插件后无活动 hook 或工具残留。

请在 `docs/progress.md` 记录 DSH/Windows 版本、日期与证据路径；不要在提交中包含
真实模型凭据、会话内容或个人 profile 设置。
