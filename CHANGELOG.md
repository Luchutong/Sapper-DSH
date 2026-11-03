# Changelog

## 0.1.0-alpha.4 — 2026-11-03

- M1 已获用户验收；修复普通图写入反复审批与 never 策略冲突的问题。
- 默认 store.approval=session，图维护连续执行；显式确认点和可选 always 模式保留审批。
- 接入同版本 SandboxPolicyService，拒绝只读/越界/缺失策略服务，提交前检查权限撤销。
- 旧 orchestration.requireApproval 不控制图存储，升级无需手工迁移配置或图文件。
- 设置页新增图写入策略，使用真实嵌套 mutation 协议；更新连续执行验收与权限契约。

## 0.1.0-alpha.3 — 2026-11-03

- M0 由用户确认验收完成，交付 M1 存储与六个工具。
- Python 兼容图文件、节点/引用校验、ID 分配、文档比较更新与意图生命周期。
- per-root 队列、TS 跨进程锁、原子替换和可恢复多文件事务。
- 本地 flag 捕获去重、权威事实与可重建 ledger、显式状态更新，不联网提交。
- 接入真实 DSH 写审批和禁用守卫；敏感状态操作始终询问。
- 固定上游 Store 快照的 Python/TS 往返与两个独立 Node 写者验证。
- 发布 M1 验收/存储指南；global / autoInit、frontier / recall 与编排仍待后续阶段。

## 0.1.0-alpha.2 — 2026-11-03

- 对齐 DSH 0.2.1-rc.2、Cordis 4.0.5、Schemastery 3.18.5。
- 迁移 volatile Config、SettingsForms、configForms 与当前客户端插槽。
- 使用 producer-owned 消息来源；处理配置写入返回 false 的情况。
- 在测试、CI 和打包中加入官方 DSH 安装兼容检查，保留旧包拒绝回归。
- 记录旧 SDK 缓存导致安装失败的原因，更新安装和验收文档。

## 0.1.0-alpha.1 — 2026-11-03

- 初始 M0 宿主/客户端骨架，目标为旧 SDK 0.1.5-rc.1。
- 已确认无法安装到 DSH 0.2.1-rc.2；由 alpha.2 替代。
