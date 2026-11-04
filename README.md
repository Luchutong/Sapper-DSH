# Sapper DSH

将 [sapper-v2](https://github.com/N1nEmAn/sapper-v2) 的事实图与
`reason → explore → verify` 循环移植为 DSH NEXT 桌面插件。

**当前版本 `0.1.0-alpha.13`：左侧比赛工作台，一键创建题目目录、DSH 工作区与主会话；持久化队列默认并行两题，结束生成一次主助手简报。**
目标运行时为 **DSH 0.2.1-rc.2**，Cordis 4.0.5 / Schemastery 3.18.5。

当前可维护工作区事实图、意图、长文档和本地 flag；每轮注入有预算的 frontier、
历史与相关证据指针，支持中英文召回、56 条离线 KB 及 `/sapper` 只读命令。
完全权限下 Sapper 自身的确认门自动通过，仍保留工作区、归属和数据完整性约束。
点击桌面左侧 **Sapper 比赛工作台** → **新建题目** → 首次选择比赛根目录 → 输入目标 → **创建并开始**。
题名可选；模型、preset 与权限会明确显示，之后沿用最近选择，不自动提升权限。
无需预先准备工作区或主会话，创建后自动打开主会话并快速受理，输入可继续使用。
工作台聚合求解、定向复核、WP 与纠错重跑；查看历史只读，浅色/深色及窄屏布局均支持。
结果卡片即时回传，最终真实助手简报按执行去重。见 [工作台使用说明](docs/task-panel.md)。

## 工具

| 工具 | 当前操作 |
| --- | --- |
| sapper_task | start / resume / continue / verify；按用户目标自动建独立图并运行，保留旧图 |
| sapper_init | create / recover；初始化不覆盖已有文件，recover 重放待完成事务 |
| sapper_status | summary / frontier / graph；项目状态、数量、就绪/阻塞分组与完整性诊断 |
| sapper_fact | create / get / list；可在创建结果事实时原子结案 source_intent |
| sapper_intent | create / get / list / claim / release / confirm / conclude |
| sapper_doc | get / set；写入需提供最近读取的 expected_doc |
| sapper_flag | record / list / update；本地记录与去重，不联网提交 |
| sapper_recall | 按标题/描述召回事实与意图；返回 ID、摘要、匹配原因，不展开 doc |
| sapper_kb | search / get / list；离线知识检索，get 才展开详情与命令示例 |
| sapper_control | status / result / steer / continue / verify / cancel；主会话干预与后台后续阶段 |
| sapper_dispatch | reason / explore / verify / run / status / recover；有预算的子代理循环与运行记录 |

普通图写入默认跟随 DSH 会话文件权限自动执行，不逐次请求批准；包括初始化、文档、
领取/结案、flag 本地状态与项目完成。完全权限视为持续授权，即使意图标有
requires_confirmation 或设置为 always，也不额外 ask；确认来源记录为
`dsh-full-access`。工作区写入模式仍保留这些显式审批，只读会话拒绝写入。

旧 orchestration.requireApproval=true 不再控制图数据，升级无需手工改旧配置。
关闭插件会清理工具和摘要；提交前重查会话权限、配置和取消信号。详细策略见
[自动化与权限](docs/permissions.md)。工具不会执行图中描述的命令。

输入 `/sapper status`、`/sapper graph`、`/sapper frontier`、
`/sapper recall 中文关键词`、`/sapper flag`、`/sapper kb kb001` 可直接查看数据，
命令不调用模型、不修改图。上下文默认 6000 字符，所有动态分区共用预算；
`context.inject=false` 停止注入与自动图/KB 读取。配置及召回规则见
[M2 上下文契约](docs/m2-context.md)。

## 子代理编排

面板发起任务或 `/sapper start <目标>` 会自动准备存储并开始运行。已有图也可
显式调用 `sapper_dispatch {"mode":"run"}` 或 `/sapper run`，开始后连续推进就绪意图，
必要时 reason 提出新任务，explore 收集候选证据，普通候选经 verify 独立复核后才原子写入
`verification_status=confirmed` 的事实。`/sapper runs` 只读查看运行摘要。`/sapper start` 和 `/sapper run` 立即返回后台任务编号；用 `/sapper job` 查看进度、`/sapper cancel` 取消。
子代理从实际 preset 继承文件/命令工具，启动时记录 tools/external_tools 清单；
缺工具或 max-tokens 时停止本轮并报告原因。alpha.6 的失败图可直接重跑，不需重建。

求解阶段首次提交有成功工具回执的 `kind=flag` 候选后立即停止其他路线并回传，不再等待自动复核；该结果明确标为未确认候选。显式 verify 仍可独立复核。已确认 flag 也会阻止后续无关探索，避免重复晋升与重复规划。结束本轮不伪造项目的独立验证完成状态。

工作台启动会立即在主会话显示受理与阶段卡片。运行中用 `/sapper steer <新方向>`：先停止并回收旧路线，再保留证据启动关联的新阶段。结束后 `/sapper wp [要求]` 根据已有证据编写本地 WP，`/sapper retry [纠错要求]` 重新取证，`/sapper continue <目标>` 开始后续工作，即使原项目已 completed 仍可使用。普通聊天可调用 `sapper_control` 完成这些操作，原任务与证据保留。

默认使用 DSH 内置 spawn，模型继承父会话；无需配置第三方 CLI。角色、模型、超时
和工具权限均通过当前 DSH 接口。候选与失败记录保存在 `.sapper/runs/`，失败意图
重新开放并留下 hint。模型文字声明不能代替本次真实工具输出。

预算默认最多推进 24 条意图、20 次探索，同一候选最多复核 2 次，并发 2。子代理初始
24 步，explore/verify 在持续取得新外部工具证据时自动延长至最多 128 步，reason 使用初始步数；
保留最后两步提交结构化结论。每子会话 45 分钟、整轮 90 分钟，每次请求最多输出
16384 token。设置页可调整预算或选择固定步数；旧显式配置保留。自动执行由显式启动触发；
`orchestration.auto` 的普通聊天自动触发仍预留。详见 [M3 契约](docs/m3-orchestration.md)。

## 存储

工作区 `.sapper/` 使用与 Python 版兼容的 project / facts / intents / hints JSON。
串行队列、TS 写者 LOCK、临时文件原子替换和可恢复事务保护多文件更新。
flag 事实是权威记录，`flags/ledger.json` 是可重建索引。详细边界与格式见
[存储说明](docs/m1-storage.md)。

当前支持任意普通 DSH workspace；global 仍未开放。面板明确发起新任务时自动创建
`.sapper/tasks/<任务ID>/`，通过目录索引选择当前图，同目录下的新任务相互隔离。
已有 `.sapper/project.json` 在面板显示为原任务；可以直接继续。状态查询和页面打开不写入。
旧 M0 最小 project.json fixture 只能供目标摘要探针读取，写入前请在新测试目录
初始化完整图。插件不会静默覆盖或补写旧测试文件。

## 安装与开发

在 DSH NEXT 菜单“打开 DSH 终端”，执行后重启应用：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.13.tgz"
```

开发需要 Node.js 22+、pnpm 8.15.4 和 Python 3（仅 golden 测试使用）：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm check:compatibility
corepack pnpm pack --pack-destination dist
```

`check` 包含类型检查、自动化测试、双端构建、两个独立 Node 进程写入检查和产物
检查。CI 覆盖 Ubuntu / Windows × Node 22 / 24。Python 参考代码仅用于测试，
不进入安装包，桌面用户无需 Python。官方 DSH 兼容门禁在 CI 和打包时运行。

## 工程与进度

- `src/store/`：校验、路径、队列、原子 IO、事务与图操作。
- `src/tools/`：图工具、召回、KB、编排与会话控制，以及写入分类。
- `src/dsh-adapter/`：DSH 生命周期、审批、slash commands 和消息来源边界。
- `src/client/`：左侧比赛工作台与输入框入口、进度时间线、事实图、主会话结果卡片与预算设置。
- `src/workbench/`：原生启动协调、持久化队列/偏好、主助手简报与 WP 历史归档。
- `src/render/`：frontier、历史、状态和共用预算的上下文；不自动展开 doc。
- `src/recall/`、`src/kb/`：中英文子串/词边界/bigram 排序，离线 KB 和工作区自定义覆盖。
- `src/orchestration/`：reason/explore/verify、证据门、预算、取消与子代理回收。
- `resources/`：56 条可检索 KB、三个已接入的角色 prompt 与上游许可。
- `tests/reference/`：固定 revision/哈希的上游 Store/frontier/history 快照，仅用于测试。

[项目进度](docs/progress.md) · [架构](docs/architecture.md) ·
[SDK 契约](docs/sdk-contract.md) · [兼容事故经验](docs/lessons-learned.md) ·
[原计划快照](docs/plan.html) · [GitHub 阶段跟踪](https://github.com/Luchutong/Sapper-DSH/issues/1)

项目采用 MIT 许可，上游来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
