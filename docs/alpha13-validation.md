# alpha.13 比赛工作台验收

DSH 固定为 `0.2.1-rc.2`。本文记录实现、测试边界与升级经验；test4 工作区与原始记录保持只读。

## 交付内容

- 桌面原生左侧 `sidebar.panellist` / `main` 比赛工作台；无需已有工作区。输入框与设置页跳转同一入口。
- 选比赛目录、填写目标后，创建安全命名的题目目录、原生工作区及命名主会话，再通过 CommandRuntime 快速受理任务。目录、工作区、会话、job 分步骤持久化，重复请求复用 requestId。
- 宿主 FIFO 队列默认并行两题，范围 1–8；调整偏好不影响编排 Config 和运行权限指纹。取消排队不产生模型请求，切换页面不取消任务；重启续调排队项，原执行项标为中断。
- 即时卡片及一次真实 Agent.followup 主助手简报；忙碌时延后，真实用户输入优先，自动简报禁用工具且不影响正常用户轮次，失败可重试。
- 题目聚合求解、复核、WP 与纠错；按 workspace/task/run 读取历史，查看不执行；定向 verify 只推进被选中的候选。
- 分栏与五标签详情、文本文件预览、依赖分层图、适应视口/缩放/拖动/重置、完整节点详情、明确的未纳入节点计数。
- WP 按生成运行归档字节快照与 SHA256；后续 WP 改写和 flag 复核不改变先前生成记录的证据状态。

## 自动化覆盖

保留原 150 项测试，扩展为 **172 项**。新增回归重点：

| 范围 | 覆盖 |
| --- | --- |
| 原生创建 | 无已开会话；真实 WorkspaceRegistry、SessionController、CommandRuntime、Gateway；中文及 Windows 保留名称、同名去重；工作区/会话/标题/受理各阶段失败恢复；重复点击 |
| 队列 | 两题执行、第三题排队；降低不取消已运行题目、提高后调度等待项；取消排队无模型请求；DSH 子代理容量等待；真实 JSONL/Domain 重启恢复 |
| 主会话 | 快速受理与实际 SubmitMachine 输入器恢复；一次助手文本简报；忙碌排队；紧邻 followup 的真实用户优先；恶意简报工具调用被拦截；普通用户工具恢复；失败/完成简报不重放 |
| 历史与 test4 回归 | 候选 flag 早停、单独 verify 不探索其他 ready 路线、WP 生成/独立读取、纠错续跑；旧 run 不变；同名 r001 按阶段查询；浏览不切换 active 图、不重复回传 |
| 文件/图 | WP 历史快照保留原字节；路径越界/未知工作区拒绝；依赖多轮分层与循环节点保留；完整节点查询 |

最终构建浏览器探针使用 **真实 DSH SlotCore、LayoutController**、构建后的 lazy-CJS 客户端和真实 Host Gateway。启动流程接真实原生工作区/会话接口，不仅是独立 React 页面。模型使用确定性适配器；无附件场景的上传入口和附件限制使用固定测试协作者。

浏览器矩阵：浅色/深色 × 1024/1280/1440；覆盖长中文标题与目标、32 个历史题目、330 个意图的事实图、未纳入节点计数、键盘选择节点、平移缩放、搜索、只读历史和 WP 文件打开。报告/截图位于本地 `dist/validation/workbench-*`。

```sh
corepack pnpm install --offline --frozen-lockfile
corepack pnpm check
# 构建结束后运行；禁止与重建 lib 并行
SAPPER_BROWSER_PROBE=1 corepack pnpm exec vitest run tests/orchestration.test.ts -t 'actual client and host Typert'
# 从最终 lib 加载宿主插件，再跑真实 SDK 集成
SAPPER_PACKAGED_HOST=1 corepack pnpm exec vitest run tests/orchestration.test.ts
```

## 本次排查经验

1. **跟随主会话不等于唤醒主助手**：`inject()` 只入队上下文，自动简报必须用 `Agent.followup()`；任务卡片是独立的可见记录。
2. **简报权限必须按轮次隔离**：不能给整个主会话持久禁用工具，否则用户刚提交的新任务也会被拒。宿主持有独立执行信号；自动简报限制结束后清除，真实用户优先。
3. **普通自定义事件不能直接成为必需的会话日志事件**：alpha.12 的 `sapper/result` 在内存可见，但真实 JSONL 冷恢复拒绝未知、未标记可忽略的事件。alpha.13 使用 SDK 的 `appendPluginRecord` 写 `plugin:sapper-dsh/result`，带 `ignorable: true`，读取时校验数据；客户端仍能展示已加载的旧卡片。
4. **不能把恢复失败归因于插件而省略原生依赖**：原生 SessionController 的 imageLimits 投影要求附件服务公开有效限制。重启集成夹具补齐这一配置，保留真实投影/会话恢复，不替换恢复算法。
5. **WP 状态与当前 flag 状态要分别记录**：历史结果按所选 run 的证据读取，新 WP 同时保存独立字节快照；后续文件覆盖和复核不会回写旧结果。

升级前已经写入旧 `sapper/result` 的主会话日志不会被自动改写。若该旧主会话被 DSH 冷恢复拒绝，可在原工作区新建普通主会话后继续使用原 `.sapper` 图；不需要重建证据。test4 的旧主会话和原始 WP 不做迁移或清洗。新建题目使用 alpha.13 的可恢复记录格式。

## 发布验证

本地已通过类型检查、172 项回归、最终宿主产物 61 项集成、双端构建、官方兼容门禁、双进程存储检查及最终客户端浏览器矩阵。Windows DSH 0.2.1-rc.2 隔离 profile `sapper-m1-release` 升级安装退出码 0，无兼容豁免；归档及安装后的宿主、客户端哈希均与本次构建一致。没有修改真实 desktop profile。

Ubuntu/Windows × Node 22/24 的四项检查通过本仓库 [CI](https://github.com/Luchutong/Sapper-DSH/actions/workflows/ci.yml) 运行；最终对应提交、结果和下载入口在 [进度 issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1) 同步。仅在四项全部通过后标记本版交付。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.13.tgz | `315d782888f19e509658abe3ed2cdea0d8bf2893eca8b3accfd87fbd7a841b0f` |
| lib/index.js | `597790eed7ebcf9c0ad6660de72286c0adba4b26467f300e3141283ed4905e2d` |
| lib/client.js | `4e5836795263d6db420f31ad64dba184680d7c292687319e08dc1a51c39b9f35` |

Windows 安装包：`D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.13.tgz`。本地验证日志为 `dist/validation/alpha13-{check,tests,packaged-host,browser,pack}.log`、`windows-upgrade-alpha13.log`；截图/JSON 为 `workbench-*`。
