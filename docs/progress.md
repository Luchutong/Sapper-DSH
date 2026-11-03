# 项目进度

更新日期：2026-11-03（Asia/Shanghai）。

**M0 已由用户确认验收完成；当前交付为 alpha.3 / M1 存储与工具。**
M1 实现和本地自动检查已完成，新版本桌面交互待用户验收。
GitHub 跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 / 下一步 |
| --- | --- | --- |
| M0 技术验证 | 完成 | 用户先提供安装、工具读取和目标摘要反馈，随后明确确认“验收完成” |
| M1 存储与工具 | 实现与本地自动验证完成 | 六个工具、队列、LOCK、原子 IO、事务恢复、flag 索引、Python 往返；新包桌面待验收 |
| M2 上下文与召回 | 未开始 | 完整 frontier、历史、bigram recall、KB 与 slash commands |
| M3 编排 | 未开始 | DSH 子代理、审批/预算、candidate → verify → confirmed |
| M4 配置页 | 未开始 | 完整表单、诊断 RPC、图预览 |
| M5 打包与验收 | 未开始 | 干净环境、迁移与升级路径 |

## M0 验收来源

用户确认 alpha.2 可成功安装，并提供 sapper_status 从 uninitialized / 空目标到
active / SAPPER-M0-9B31 的两次返回，随后提供未调用工具回答目标的会话文本。
之后用户明确确认验收完成并要求推进 M1。M0 接受结论以该确认记录，原始桌面
请求/截图未另行采集；历史逐项记录保留于 [m0-validation.md](m0-validation.md)。

## M1 本轮交付

- 升级开发包至 0.1.0-alpha.3，SDK 仍精确适配 DSH 0.2.1-rc.2。
- 六工具：sapper_init / status / fact / intent / doc / flag；存储初始化不覆盖旧文件。
- ID 分配跳过占用文件，校验字段/文件名/引用；坏节点可诊断，写入在坏图上停止。
- 事实与意图读写、确认/领取/释放/结案、文档比较更新、项目终态一致性。
- per-root 队列、TS 跨进程 LOCK、临时文件替换、可重放多文件事务。
- flag 保留 Python 事实格式，ledger 为可重建索引；去重、来源和显式状态更新，无网络提交。
- 默认写入询问；confirm、结案到 goal、flag 状态更新始终经 DSH 审批。
  关闭/卸载和审批等待期间的配置变更有执行前及提交前检查。
- 保留 MIT 许可与固定哈希的上游 Python Store 测试快照，桌面安装包不含 Python。
- 客户端进度文案和开发文档同步到 M1，完整设置表单与图预览仍待后续阶段。

## 验证证据与边界

- 本地 TypeScript 检查通过；8 个测试文件、56 项用例覆盖存储、SDK 生命周期、真实
  ToolRuntime 审批拒绝/缺失/取消、文档冲突、所有六工具以及 Python/TS 往返。
- 故障用例覆盖真实 rename 失败后的日志保留与恢复，读取不擅自修复，非法日志路径被拒。
- 打包检查包含两个独立 Node 进程写入同一图，争锁后有限重试，验证数量、ID 与引用一致。
- 官方安装兼容门禁对 alpha.3 / DSH 0.2.1-rc.2 通过，无版本豁免。
- Windows DSH NEXT 自带安装器在临时 DSH_HOME 中完成 alpha.2 → alpha.3 升级，
  最终 alpha.3 包又在新的 sapper-m1-release profile 安装成功，退出码均为 0。
  本地日志为 dist/validation/windows-upgrade-alpha3.log 与 windows-install-alpha3.log；
  未修改现有 desktop profile，桌面页面/模型交互仍待 M1 验收。
- CI 配置覆盖 Ubuntu / Windows × Node 22 / 24，Python 3.12 仅供 golden 测试。
- 本轮验证在临时图中进行，未修改现有 desktop profile，未调用模型或连接目标。

本机交付：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.3.tgz`，附 SHA256 文件。
SHA256：`0f5e31a6b4fb31db4c1b170e70a9325884ec1f39001c61a306f19458d64e35d6`。

当前开放 workspace 存储。global / autoInit 仍为预留项，显式 sapper_init 是建图入口。
上下文仍只注入目标；尚无完整 frontier、recall 或编排。M0 两字段测试文件只保留
摘要读取能力，不自动升级为可写图。TS 的 LOCK 与 Python flock 不互通，必须顺序
交接写入。详见 [存储契约](m1-storage.md)。

## 下一步

2026-11-03 M1 首轮反馈：用户以 goal=SAPPER-M1-LOCAL：验证存储、origin=desktop fixture
调用 sapper_init，返回 `Error: the user rejected tool "sapper_init"`，并报告事实图
未创建、状态仍为 uninitialized。拒绝路径符合预期（用户反馈，未另采集文件系统日志）；
批准初始化及后续写入链路仍待验证。用户贴出的会话说明称审批提示已禁用。

已核对安装版 DSH 0.2.1-rc.2：approval=never 在审批服务直接返回 rejected，工具
主体不执行；默认“完全权限”预设使用 never，“工作区内修改”使用 ask。验收指南已
补充 `/permission` 当前会话切换入口。该反馈不要求修改插件审批策略或手工初始化。

将 alpha.3 安装到 DSH NEXT 后，按 [M1 验收指南](m1-validation.md) 检查审批拒绝
无写入、六工具闭环、重启持久化与启停/卸载。完成 M1 验收后推进 M2。

历史兼容事故与发布检查见 [lessons-learned.md](lessons-learned.md)。
