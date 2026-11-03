# 项目进度

更新日期：2026-11-03（Asia/Shanghai）。

**M0/M1 已由用户确认验收完成。当前 alpha.4 修复过度审批，普通图数据维护默认自动执行。**
GitHub 跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 / 下一步 |
| --- | --- | --- |
| M0 技术验证 | 完成 | 用户确认安装、设置、工具和目标摘要验收完成 |
| M1 存储与工具 | 完成，用户已验收 | 六工具、存储/锁/恢复、Python 兼容；alpha.4 补充自动化权限修复 |
| 权限修复 alpha.4 | 实现与本地验证完成 | 默认随会话自动写图，保留必要约束，新包桌面回归待验证 |
| M2 上下文与召回 | 未开始 | 完整 frontier、历史、bigram recall、KB 与 slash commands |
| M3 编排 | 未开始 | DSH 子代理、预算与证据验证门，支持授权任务连续推进 |
| M4 配置页 | 未开始 | 完整表单、诊断 RPC、图预览 |
| M5 打包与验收 | 未开始 | 干净环境、迁移与升级路径 |

## 用户验收记录

M0：用户确认 alpha.2 安装、sapper_status 从 uninitialized 到 active 及目标摘要反馈，
随后明确确认“验收完成”并要求推进 M1。历史逐项证据见 m0-validation.md。

M1：用户提供 alpha.3 桌面调用文本，包含第一次 init 被拒绝、重试初始化成功、状态
与计数读取、f001 创建、带确认门的 i001 创建与领取、f002 原子结案，以及重复结案
后 facts=2 / intents=1 / open_intents=0 / warnings=[] / integrity=[]。随后明确确认
“已完成验收”，要求正常任务不再反复人工确认。这里记录用户反馈，未另采集桌面
原始事件或文件系统日志，不将模型描述补写为独立观测证据。

## 权限问题与修复

alpha.3 把内部图数据写入默认归入 ask，并对项目完成和本地 flag 状态也强制询问。
在 DSH 的 never 策略下会自动被拒绝，造成正常任务中断。该审批范围过宽，按用户
最新自动化要求改为：

- 默认 store.approval=session；init/recover、事实与文档、普通意图、flag 本地状态、
  项目完成按 DSH 会话文件权限自动执行，不额外逐次 ask。
- 使用真实 SandboxPolicyService 解析当前会话 mode / workspaceRoot；只读、缺失服务、
  越界、运行中撤销写权限时拒绝未提交写入。
- 保留其他 DSH 策略的 deny/ask，插件不改变平台权限，不伪造批准或进行沙箱提权。
- 只有显式要求人工决策的 requires_confirmation 意图和用户主动选择的 always 模式
  才询问。正常自动化意图默认 false。
- 旧 orchestration.requireApproval=true 不控制图数据，新字段由 schema 默认 session，
  升级无需手工修改旧 profile；磁盘图格式不变。
- 设置页增加“图写入确认”选项；嵌套字段使用 ConfigForm.mutate 路径数组保存。
- 图边界、不可覆盖初始化、文档比较更新、意图归属、坏图保护、事务恢复继续有效。

权限设计、升级与后续外部能力边界见 [permissions.md](permissions.md)。

## 本地验证

- 8 个测试文件、65 项用例与 TypeScript 检查通过。
- 真实 ToolRuntime + SandboxPolicyService 验证：完全权限/never 风格答复器下普通链路
  运行至 completed，审批调用为 0；workspace-write 同样无额外审批。
- 只读、权限服务卸载、执行前/审批期间撤销权限均阻止写入，状态查询仍可用。
- 显式人工确认点、可选逐次审批模式、其他策略拒绝和取消路径保留。
- 旧配置默认值、客户端字段保存、真实 SettingsForms 嵌套 mutation 与 revision 约束通过。
- 保留固定哈希的上游 Python/TS 往返、存储故障/并发、两个独立 Node 写者和包 VM 检查。
- 官方兼容门禁通过：alpha.4 / DSH 0.2.1-rc.2，无版本豁免。SDK 增加同版本
  dsh-sandbox-policy peer 与测试依赖，测试/peer 声明一致。
- 冻结锁文件离线安装检查通过。CI 继续覆盖 Ubuntu/Windows × Node 22/24。
- Windows DSH NEXT 自带安装器在临时 DSH_HOME / sapper-m1-release profile 中
  完成 alpha.3 → alpha.4 升级，退出码 0，无版本豁免。本地日志：
  dist/validation/windows-upgrade-alpha4.log；现有 desktop profile 未修改。
- 本轮未修改现有 desktop profile，未调用模型、连接目标或提交真实 flag。

本机安装包：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.4.tgz`，附 SHA256 文件。
SHA256：`e0d27d6dcb60319092305e1856df5f87ae5c439ab6cc1e52cfcd9d3a00e9109d`。

## 下一步

安装 alpha.4 后按 [连续执行验收指南](m1-validation.md) 的单次指令做权限回归，
正常图维护无需逐步人工确认。当前仍是 workspace 存储，autoInit/global 保留，
完整 frontier、recall 与 reason/explore/verify 调度按 M2/M3 推进，不能将权限修复
表述为完整自动解题器已经实现。
