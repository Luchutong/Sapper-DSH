# 项目进度

更新日期：2026-11-03（Asia/Shanghai）。

**M0/M1 与 alpha.4 已由用户确认功能正常。alpha.5 实现完全权限自动确认与 M2，桌面交互待本轮验收。**
GitHub 跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 / 下一步 |
| --- | --- | --- |
| M0 技术验证 | 完成，用户已验收 | 安装、设置、工具和目标摘要 |
| M1 存储与工具 | 完成，用户已验收 | 六个基础工具、存储/锁/恢复、Python 兼容 |
| 权限修复 alpha.4 | 用户反馈功能正常 | 普通图维护自动执行；确认门问题在 alpha.5 修复 |
| 完全权限修复 alpha.5 | 自动回归通过，桌面待验收 | 持续授权覆盖 always/显式确认门，保留平台拒绝与边界 |
| M2 上下文与召回 | 已实现，桌面待验收 | frontier/历史、共用预算、中英文 recall、离线 KB、只读命令 |
| M3 编排 | 未开始 | DSH 子代理、预算和证据验证门 |
| M4 配置页 | 未开始 | 完整表单、诊断 RPC、图预览 |
| M5 打包与验收 | 未开始 | 干净环境、迁移与升级路径 |

## 用户验收记录

M0：用户确认 alpha.2 安装、sapper_status 从 uninitialized 到 active 及目标摘要反馈，
明确确认“验收完成”并要求推进 M1。历史证据见 m0-validation.md。

M1：用户提供 alpha.3 调用文本，首次 init 被拒绝，重试后建图成功；事实、受限意图、
确认/领取和结果事实原子结案成功，重复结案后 facts=2 / intents=1 / open_intents=0，
warnings/integrity 为空。用户确认“已完成验收”，要求去除普通图维护的反复审批。

alpha.4：最新反馈显示状态与事实/意图正常，受限意图先阻塞、经 confirm 后领取与
结案成功。用户明确“可认为功能正常”，同时要求完全权限默认通过审批并推进 M2。
上述为用户提供的调用文本，未另采集桌面原始事件；不将其当作 alpha.5/M2 的验收证据。

## alpha.5 / M2 交付

- 完全权限下 Sapper 自身确认门自动通过，包括 store.approval=always。保留确认标记，
  claim/结案事务记录 confirmed_at 和 confirmation_source=dsh-full-access。
- workspace-write 的显式 confirm/always 仍请求审批；只读、其他 DSH 策略、权限撤销、
  工作区路径、doc 比较更新、归属、坏图和恢复约束保持有效。不改变 DSH 审批服务。
- frontier 就绪/阻塞分组、近期事实、已结案意图与 hint；所有分区共享字符预算，
  整节点省略，支持 goal-only/frontier/frontier-history，不自动展开 doc。
- 新增 sapper_recall：中英文子串、英文词边界和 bigram Dice。新增 sapper_kb：
  search/get/list、56 条离线知识、工作区自定义覆盖、详情按需展开。
- /sapper status、graph、frontier、recall、flag、kb：真实 CommandRuntime，直接返回只读结果，不调用模型。
- context.inject=false 后不加 snapshot、不读图或 KB；关闭插件同时清理工具/命令。
- 同版本 dsh-commands peer；attachment/session/typert-protocol 仅用于真实命令运行时测试。

## alpha.5 验证

- 11 个测试文件、96 项测试、TypeScript 检查通过。
- 真实 ToolRuntime/SandboxPolicyService：完全权限、拒绝任何 ask 的答复器下，session
  和 always 均可连续完成受限意图确认/领取/原子结案，审批调用为 0；确认来源可追溯。
- 其他策略 ask/deny、只读、权限服务缺失、执行中撤销权限继续阻止写入。
- 500 节点纯渲染与实际磁盘图、三种 scope、多种预算、注入关闭时零图/KB 读取通过。
- 中英文召回、doc 不自动展开、56 条 KB、自定义覆盖/路径边界、真实 CommandRuntime
  生命周期、固定上游 Python Store/frontier/history 对照通过。
- 双端构建、两个独立 Node 写者、产物 VM、打包 KB 实读、官方兼容门禁通过，无版本豁免。
- 冻结锁文件离线安装通过；CI 继续覆盖 Ubuntu/Windows × Node 22/24，
  同一提交的最终结果见 [Actions](https://github.com/Luchutong/Sapper-DSH/actions)，发布结果同步 issue #1。
- Windows DSH NEXT 自带安装器在临时 DSH_HOME / sapper-m1-release profile 完成
  alpha.4 → alpha.5 升级，INSTALL_EXIT_CODE=0，dependencies/bundles 已登记，无版本豁免。
  本地日志：dist/validation/windows-upgrade-alpha5.log；现有 desktop profile 未修改。

本机交付：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.5.tgz`，附 SHA256 文件；
仓库 dist 保留同一份新包和旧包。新包包含 68 个文件、56 条 KB，SDK peers 均为
0.2.1-rc.2，不含 Python 或测试代码。
SHA256：`7de366f7e21e733efc955da4186a57a927619f965e0b1e43ce8b9983dcdf42d6`。

本轮不修改现有 desktop profile、不访问目标或提交真实 flag。Python 仅在开发测试
使用，不进入插件包。TS/Python 写锁不互通，写入必须顺序交接，详见 m1-storage.md。

## 历史权限修复与发布

alpha.3 默认把所有图写入归为 ask，与 DSH never 冲突；alpha.4 改为普通图维护
跟随真实会话文件权限自动执行。用户主动设置 always 或显式确认门仍曾触发审批，
alpha.5 按最新要求在完全权限下统一采用持续授权。

alpha.4 自动回归为 65 项，Ubuntu/Windows × Node 22/24 CI 全绿；Windows DSH NEXT
在临时 DSH_HOME / sapper-m1-release profile 完成 alpha.3 → alpha.4 升级，退出码 0。
历史日志 dist/validation/windows-upgrade-alpha4.log；包保留于 dist 与 Windows 同步目录。
SHA256：e0d27d6dcb60319092305e1856df5f87ae5c439ab6cc1e52cfcd9d3a00e9109d。
完整事故经验见 [lessons-learned.md](lessons-learned.md)。

## 下一步

安装 alpha.5 后按 [M2 验收指南](m2-validation.md) 验证完全权限、frontier/召回、KB
与命令。上下文规则和 Python 召回差异见 [M2 契约](m2-context.md)。通过后推进 M3
子代理调度、预算与证据门。当前仍是 workspace 存储，autoInit/global 保留；M2 没有
自动分派任务或实现完整自主解题器。
