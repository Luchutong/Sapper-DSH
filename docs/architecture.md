# 架构与边界

当前工程版本为 0.1.0-alpha.21，目标 DSH 0.2.1-rc.2。后文 M0–M3 为早期设计，当前增量见各 alpha 小节。M0/M1 已获用户验收。
原计划保留在 docs/plan.html，SDK 和实现细节以当前代码与 sdk-contract.md 为准。

```text
DSH agent loop                          WebView
  agent/pre-step                          plugins.item / settings.section
  tools/pre-execute → session policy            configForms.get('sapper')
  tools.guard                             Config.set / subscribe
         │                                      │
  src/dsh-adapter/host.ts                src/client/
         │                                      │
  src/tools/ 九个工具 + /sapper                      DSH Config transport
         │                                      │
  GraphStore → per-root queue              Loader volatile Config
         │
  LOCK → 校验 → journal → atomic rename
         │
  workspace/.sapper/
```

## 宿主与工具

Cordis apply 声明 tools / agents 依赖，读取 Loader 提供的 volatile Config。
Settings 为可选服务；有服务时声明自带客户端页面、auto=false，由 id=sapper
条目派生表单。设置变更由 DSH 配置编辑器写入 profile Cordis patch。

启用时注册 status / init / fact / intent / doc / flag / recall / kb / dispatch 九个工具。普通图写入默认跟随
真实 SandboxPolicyService 的会话写权限自动执行，read-only 或缺失策略服务时拒绝。
workspace-write 的 confirm/always 才询问，完全权限作为持续授权自动通过自身确认门，
事务记录 dsh-full-access 来源。其他策略的 ask/deny 保留，
guard 和提交前检查阻止会话撤销写权限、配置改变或插件关闭后的未提交写入。
工具分类只把只读操作标记为可并发；内部存储仍有共享队列。

Store 保留 Python 的事实、意图、文档与 hint 布局。flag 事实为权威记录，ledger
按需重建。多文件提交通过可重放日志恢复；ID 分配、反向引用和项目终态属于同一
事务。完整格式、崩溃与跨进程边界见 [m1-storage.md](m1-storage.md)。

## 上下文与客户端

agent/pre-step 先执行 next，保留拒绝/取消。只在已选择工作区、存在项目目标、
有正常入场消息时附加有预算和不可信声明的 frontier/历史/召回/KB。每轮移除旧的
Sapper snapshot；producer-owned source.kind=sapper-dsh，form=snapshot。所有分区
共享字符预算，完整段落省略，不展开 doc。inject=false 在图/KB 读取前返回。
读取检查锁与事务，不自动初始化或恢复；旧两字段 M0 fixture 仅目标回退。

recall 采用归一化子串、英文词边界与中英文 bigram Dice。KB 从插件资源加载，
支持受工作区约束的自定义覆盖。可选 commands 服务注册 /sapper 查询命令，直接返回
结果，不调用模型或改图；run 经 tools.execute 启动 M3，runs 查询运行摘要。
细节见 [M2 契约](m2-context.md) 与 [M3 契约](m3-orchestration.md)。

客户端通过 configForms 读取宿主镜像；启用字段使用 set，嵌套的图写入策略使用
mutate 路径数组，仅用户主动切换后写入。false 显示拒绝
保存；仅打开页面不写默认值。完整表单和图预览为 M4，当前 GraphPreview 是进度提示。

## 模块状态

| 模块 | 当前职责 | 后续 |
| --- | --- | --- |
| store | 校验、workspace 路径、队列、锁、原子 IO、恢复、图与 flag 操作 | global 数据目录策略、显式迁移 |
| tools | 九个工具与读写分类，按需展开 doc 和运行记录 | M4 诊断入口 |
| render | 有来源/共用预算的 frontier、历史、图与状态 | M3 证据/候选状态展示 |
| recall / kb | 中英文图召回、56 条离线知识、自定义覆盖 | M3 证据复用 |
| orchestration | 真实 spawn 子会话、角色约束、证据门、预算、模型、取消/恢复 | M4 诊断与 M5 迁移验收 |
| client | 插件卡片、启用/图写入策略字段、失败提示 | M4 完整配置、诊断与只读图预览 |

workspace 是当前唯一支持的存储模式。global / autoInit 仍为预留配置。
M3 通过显式 dispatch/run 启动受预算约束的子代理执行与独立复核；不联网提交 flag。
候选存于 runs，晋升与结案使用同一事务，见 [M3 契约](m3-orchestration.md)。

## 构建与验证

宿主为 ESM，SDK 保持 external，避免复制 Cordis 实例。浏览器为
window.__ModuleLoader__.load 注册的 lazy-CJS factory，只引用宿主共享 React。
dsh.client.inject 声明客户端依赖，exports['./client'] 指向客户端产物。

验证包括真实 Loader/SettingsForms、真实 ToolRuntime 审批管线、存储故障与并发、
固定哈希 Python Store 往返/frontier/history、真实 CommandRuntime、500 节点预算、
产物 VM 检查，以及两个独立 Node 写者。Python
仅存在于测试代码，桌面插件不依赖 Python。安装兼容性使用官方检查器、空豁免表，
CI 和打包阶段均执行；各版本的桌面验收分别记录。

## alpha.11 任务展示与收尾

任务命令/面板共用 TaskPanelService，发起即返回后台编号。运行结束读取实际图与运行记录，向发起者会话追加持久化 `sapper/result` 事件；客户端注册独立 Conversation Definition 和 keyed Chat 节点渲染器。结果卡片无需主模型轮次即可出现，模型上下文另收到不可信摘要。窗口支持历史结果补发。

客户端将命名空间贡献挂载和动态依赖注入分开，所有 RPC 使用注入 `remote.sapperPanel` 后的 scoped remote。输入入口使用正式 `conversation.input.left`，窗口 portal 到 document.body，避免旧 composer dock 的布局裁切。只读 SVG 关系图、子代理时间线与结果标签页共享服务状态。预算按新证据延长并预留结构化收尾，同时保留时限、硬步数上限、取消、权限和独立证据约束。

## alpha.12 交互与任务阶段

TaskPanelService 接收引擎的阶段通知，使用同一个 job_id 更新持久化主会话卡片。steer 先取消并等待原 ToolRuntime 执行体及子会话排空，再自动发起 linked continue；cancel 会删除排队方向。普通聊天通过 sapper_control 进入同一服务，仍受工具策略和根会话归属限制。

求解运行收到经过成功工具回执检查的 flag 候选后，调度器设置 flag-found 并取消其余流水线，释放未完成意图，保存候选并正常结束本轮；不自动提升 confirmed。completed 项目之后的 WP/纠错以新任务图延续，parent_task/purpose 链接历史，历史数据作为 note 继承。writeup 明确关闭 flag 早停，solve 维持早停。旧图和已确认事实保持可追溯。

## alpha.13 比赛工作台

客户端通过原生 sidebar.panellist（id=sapper）和 main（key=sapper）注册全局工作台，输入框和设置页入口跳转到同一处。根服务保持连接、轮询任务目录和持有相关 Session 引用，详情组件只负责展示；切换页面不会结束后台工作。

NativeWorkbench 将 requestId 对应的目录、原生 Workspace、Session 和 job 标识逐步保存到独立 storageDomain sapper_workbench。每一步可继续，内容不删除；目录使用安全题名、时间、随机后缀与请求标识。TaskPanelService 持有宿主队列与运行取消信号，通过 CommandRuntime 快速登记用户目标，再经 ToolRuntime 执行。独立域存储队列与界面偏好，编排 Config 的权限撤销/变更检查保持原语义。

所有详情查询按 workspaceId/taskId/runId 读取 GraphStore，不调用 selectTask、submit、report 或 dispatch。执行接口独立暴露 taskAction；定向 verify 只传入被选中的来源 run 和 intent。求解、WP 和纠错阶段通过 parent_task 聚合为题目，旧记录中的 flag 可信状态按当次运行读取。

Briefs 在结果持久化后调用 Agent.followup，忙碌或真实用户待处理时延后。简报 job ID 和消息 ID 在独立域去重；agent/pre-step 识别该自动轮，tools.guard 禁用其工具，turn/end 记录完成/失败。后台执行使用宿主持有的不可伪造 AbortSignal 与自动简报区分；正常用户轮不继承约束。失败提供显式重试，重启不重放已完成内容。

alpha.13 的可见结果记录使用 SDK `appendPluginRecord` 写 `plugin:sapper-dsh/result`（ignorable），冷恢复会保留并跳过未知记录；客户端校验 payload 并保持旧已加载 `sapper/result` 卡片兼容。旧版必需自定义事件可能被 DSH JSONL 冷恢复拒绝，不自动修改用户日志。新 WP 同时存入阶段的 `artifacts/rNNN/WP.md` 与 snapshot.json，文件预览优先读取所选运行的快照。

## alpha.17 题目附件

创建分为 prepare、原生上传、importAttachment 与 launch。prepare 仅创建可恢复的目录、工作区和会话；客户端持有 Session 引用，通过正式 fileUpload.upload 传递 File，模型不会在附件上传期间启动。importAttachment 只接受同一接收 Session 的暂存凭证，先持久化 SDK FileAttachmentRef，再从 AttachmentStore 流式复制、计算大小和 SHA256，以不覆盖目标的方式发布到本题 attachments/。客户端不能提供宿主读取路径或自行授权的文件引用。

启动清单与 accepted 文件引用保存在原 sapper_workbench 域，每个 requestId 的 prepare/import/launch 串行执行。重启后可以完成已接收文件的复制；尚在浏览器的 File 需要用户重新选择。launch 再次校验全部文件已保存且字节摘要一致，才进入原 CommandRuntime/队列。任务开始写入附件 note，长清单放 doc，避免挤占目标和上下文预算。详情与主会话卡片只展示上传元数据，不把上传成功标记成分析结论或确认事实。


## alpha.18 MCP 与模型能力

panel.capabilities 经 owner-only Remote 查询指定主会话或全局的工具目录、父会话可见性和模型元数据，不执行 MCP 工具。设置页使用原 Config transport 保存 exploreTools/verifyTools、角色模型、插件默认与角色推理档位；新题目的模型偏好另支持主会话 reasoningEffort。

统一 tool-policy 仅允许 MCP 命名空间前缀及外部工具精确名称。Orchestrator 将配置范围与父会话和祖先作用域可见工具取交集，给子代理安装有限 mask，监听 tools/change 并在推理边界更新。guard 在执行前重新检查父会话能力，不能用前缀恢复被撤销的工具。MCP 成功输出沿用原独立回执、候选与复核链。规划角色不获得 MCP，连接器本身的工作区和 Agent 激活限制仍独立生效。

推理强度通过 AgentOptions.reasoningEffort 传给正式 spawn，显式值先验证所选精确模型的 resolveModelInfo；默认继承与跨模型清除旧档位沿用 SDK 契约。模型列表之外的当前路由和已配置角色路由也查询元数据，不将目录成员资格作为执行授权。


## alpha.19 完成与复核策略

flag-policy 将 first/count/all 与候选/confirmed 计数分离，模式存于 project 与启动清单，运行快照保存当次进度；多 flag 模式同时约束早停和 GraphStore 的独立目标终态。发现通知仍在成功工具输出时发布，count 达标可先收尾，all 保留其余路线。策略覆盖通过原 Task/Dispatch ToolRuntime 写入，查看和草稿编辑不执行。

verification-policy 默认 lightweight，支持 none/selective/independent。快路径仍校验真实工具回执，保存 observed outcome、证据检查及普通观察 note，不占用第二个 verifier；evidence_completed 标记使本插件 frontier 不自动重做，原意图保留给显式 verify。只有 promoteVerified 可以创建 confirmed 事实与独立目标完成状态。角色提示词携带收集状态及复核策略，重要结论的轻量检查复用调用，并明确区分证据完整性与语义正确性。执行记录和主会话卡片分别展示这些状态。

## alpha.20：MCP 工具层与资源协调

[MCP 工具层设计](mcp-tool-layer-design.md)的首个实现位于 `src/mcp/`，工具选择取父会话/角色/工作区/能力需求交集；相同能力后端自动优先低负载者。根服务在原 ToolRuntime pre-execute 排队，最终 guard 在恢复后运行；around-dispatch 核对目标与参数，最终结果保存协议回执。工作流租约保护隐式 current 状态，调用槽按读写调度，重启遗留资源隔离，fence 单独持久化。策略独立于 Config，不误杀无关任务。

内置 native-handle 通过真实原生 MCP 创建/校验/关闭 API 提供独立资源；新资源的 native 参数仍受父/子作用域和原审批约束。`sapper_interact` 映射已有服务的持久 I/O，`sapper_observe` 保存实际工具解析的版本化测量与明确的代理推断、失败恢复建议。旧运行保留，原始工具输出按 UUID 保存为题目产物。未认证 MCP 来源仍回显，但不自动计为目标完成。

[使用与验证边界](mcp-tool-layer.md)：当前宿主协调不能覆盖外部脚本/其他 DSH 进程；没有内置可凭空启动 IDA 的进程提供者，专属进程仍须真实扩展；真实 MCP/IDA 行为由用户实际验收。
