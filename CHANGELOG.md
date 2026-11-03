# Changelog

## 0.1.0-alpha.2 — 2026-11-03

- 对齐 DSH 0.2.1-rc.2、Cordis 4.0.5、Schemastery 3.18.5。
- 迁移 volatile Config、SettingsForms、configForms 与当前客户端插槽。
- 使用 producer-owned 消息来源；处理配置写入返回 false 的情况。
- 在测试、CI 和打包中加入官方 DSH 安装兼容检查，保留旧包拒绝回归。
- 记录旧 SDK 缓存导致安装失败的原因，更新安装和验收文档。

## 0.1.0-alpha.1 — 2026-11-03

- 初始 M0 宿主/客户端骨架，目标为旧 SDK 0.1.5-rc.1。
- 已确认无法安装到 DSH 0.2.1-rc.2；由 alpha.2 替代。
