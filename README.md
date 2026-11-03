# Sapper DSH

将 [sapper-v2](https://github.com/N1nEmAn/sapper-v2) 的事实图与
`reason → explore → verify` 循环移植为 DSH NEXT 桌面插件。

**当前版本 `0.1.0-alpha.4`：M0/M1 已获用户验收，图数据维护默认连续自动执行。**
目标运行时为 **DSH 0.2.1-rc.2**，Cordis 4.0.5 / Schemastery 3.18.5。

当前可初始化工作区事实图，读写事实/意图/长文档，记录和去重 flag，显式更新
flag 状态，并通过 `sapper_status` 查看数量与完整性诊断。上下文仍只注入项目目标；
完整 frontier、recall、KB 召回、子代理编排和图预览按 M2–M4 交付。
本轮权限修复的连续执行验证见 [验收指南](docs/m1-validation.md)。

## 工具

| 工具 | 当前操作 |
| --- | --- |
| sapper_init | create / recover；初始化不覆盖已有文件，recover 重放待完成事务 |
| sapper_status | 只读项目状态、节点数量、warnings 和 integrity |
| sapper_fact | create / get / list；可在创建结果事实时原子结案 source_intent |
| sapper_intent | create / get / list / claim / release / confirm / conclude |
| sapper_doc | get / set；写入需提供最近读取的 expected_doc |
| sapper_flag | record / list / update；本地记录与去重，不联网提交 |

普通图写入默认跟随 DSH 会话文件权限自动执行，不逐次请求批准；包括初始化、文档、
领取/结案、flag 本地状态与项目完成。只读会话仍拒绝写入，显式标记需人工确认的
意图保留 confirm 审批。可在“设置 → Sapper”选择“每次写入确认”作为手动覆盖。

旧 orchestration.requireApproval=true 不再控制图数据，升级无需手工改旧配置。
关闭插件会清理工具和摘要；提交前重查会话权限、配置和取消信号。详细策略见
[自动化与权限](docs/permissions.md)。工具不会执行图中描述的命令。

## 存储

工作区 `.sapper/` 使用与 Python 版兼容的 project / facts / intents / hints JSON。
串行队列、TS 写者 LOCK、临时文件原子替换和可恢复事务保护多文件更新。
flag 事实是权威记录，`flags/ledger.json` 是可重建索引。详细边界与格式见
[存储说明](docs/m1-storage.md)。

当前只开放 workspace 模式；global 和 autoInit 仍为预留配置。请显式调用
`sapper_init` 建图；状态查询、页面打开和上下文探针不会自动创建项目。
旧 M0 最小 project.json fixture 只能供目标摘要探针读取，写入前请在新测试目录
初始化完整图。插件不会静默覆盖或补写旧测试文件。

## 安装与开发

在 DSH NEXT 菜单“打开 DSH 终端”，执行后重启应用：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.4.tgz"
```

开发需要 Node.js 22+、pnpm 8.15.4 和 Python 3（仅 golden 测试使用）：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm check:compatibility
corepack pnpm pack --pack-destination dist
```

`check` 包含类型检查、65 项测试、双端构建、两个独立 Node 进程写入检查和产物
检查。CI 覆盖 Ubuntu / Windows × Node 22 / 24。Python 参考代码仅用于测试，
不进入安装包，桌面用户无需 Python。官方 DSH 兼容门禁在 CI 和打包时运行。

## 工程与进度

- `src/store/`：校验、路径、队列、原子 IO、事务与图操作。
- `src/tools/`：六个工具、参数/返回值、写入分类。
- `src/dsh-adapter/`：DSH 生命周期、审批和消息来源边界。
- `src/client/`：插件卡片、Sapper 启用与图写入策略字段，完整表单与图预览待 M4。
- `src/render/`：有预算和不可信数据声明的目标摘要，frontier 待 M2。
- `src/orchestration/`：M3 接口预留。
- `resources/`：56 条原始 KB、三个角色 prompt 草案、上游许可；尚未注册召回与调度。
- `tests/reference/`：固定 revision/哈希的上游 Python Store 快照，仅用于兼容测试。

[项目进度](docs/progress.md) · [架构](docs/architecture.md) ·
[SDK 契约](docs/sdk-contract.md) · [兼容事故经验](docs/lessons-learned.md) ·
[原计划快照](docs/plan.html) · [GitHub 阶段跟踪](https://github.com/Luchutong/Sapper-DSH/issues/1)

项目采用 MIT 许可，上游来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
