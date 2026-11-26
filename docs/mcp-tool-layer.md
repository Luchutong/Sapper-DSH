# MCP 工具层：配置与实际验收

适用插件 **0.1.0-alpha.24**，仅支持 **DSH NEXT 0.2.2-rc.5**。

## 升级后先做什么

安装 `sapper-dsh-0.1.0-alpha.24.tgz` 并重启 DSH。设置 → Sapper → MCP 模式可选兼容模式或按需 Skill，现有配置默认使用兼容模式。

## 按需 IDA Skill

选择 **按需 Skill（本地 IDA 元数据）**。在 IDA GUI 安装并启动 MCP 插件，用 GUI 打开 IDB，将 `.i64` 或 `.idb` 保存在当前 DSH 工作区内。告诉 Agent 需要核对该文件的数据库信息。Agent 从 DSH 原生 Skill 目录发现 `sapper-ida-metadata`，在同一轮先加载说明，再调用 `sapper_ida_metadata`，传入当前工作区内的相对 IDB 路径。

该工具读取 GUI 的本机实例登记，按 IDB 完整路径匹配唯一、PID 仍存活的实例。每次请求只读取该端口的 `ida://idb/metadata`，核对返回路径及请求前后的登记。返回工作区相对路径、模块信息、IDA 上报的输入文件 SHA256（可用时）、端口、PID 和耗时。PID 存活和登记一致性是本机一致性检查，端口的进程归属仍由本机 IDA 登记提供。

按需模式下普通对话的原生 MCP 由 DSH 管理。Sapper 子代理使用本地工具及上述元数据适配器，启动时无需申请 MCP 租约。适配器是仅使用 loopback 的独立只读入口。`8745` 的共享数据库工作流和旧隔离记录的恢复仍可通过兼容模式使用。切换模式前请结束正在运行的任务。

实测可在两个 GUI 实例里打开不同目录下的同名 IDB，核对各自的路径、端口和摘要。关闭一个窗口重试时可看到对应实例失效，另一个实例仍能读取。已有窗口的启停由用户管理。

## 兼容模式

规划阶段的 `sapper_tools` 目录包含探索角色获准使用的本地文件/命令和 MCP 工具；不向只读规划代理授予执行权限。多关键词按任一词命中排序；`status` 或空查询可检查实际目录。没有专用解包 MCP 时，可先规划用现有本地命令检查解包程序与附件，不能将 MCP 搜索为空直接当作无工具。未开始探索就返回空计划会保留失败原因，而非标为正常完成。

工作流初始排队保留 FIFO，不单独按五分钟判为失败；只受用户取消、权限和整轮总时限约束。`waitMs` 限制单次原生调用/调用槽的等待，和模型步数预算分开。

未分类 MCP 默认按连接器命名空间串行。例如 `mcp__ida__*` 共享 `connector:ida`。探索和复核按整个工作流持有租约，主会话按单次调用持有。不同连接器如果实际指向同一服务，将其选择器归入同一个物理后端 ID。规划角色查询工具目录时无需申请租约。

## 超时隔离与恢复

原生 MCP 调用超时或取消后，宿主释放调用槽。如果远端是否停止仍未知，只将相应资源租约标记为 `quarantined`。已隔离资源使同域的等待调用立即收到 `RESOURCE_QUARANTINED`。新工作流可以使用未被隔离的工具，经实际重置的后端也可以重新加入。

alpha.21 的 `unclassified:mcp` 是所有未分类 MCP 共用的旧资源键，保存的租约没有连接器字段。升级遇到这条记录时，先结合会话日志确认对应服务，停止旧操作并重置该后端。随后在 **设置 → Sapper → 工具与资源隔离** 对 `unclassified:mcp` 勾选核实项，点击 **解除该资源隔离**。此步骤只处理旧格式残留。之后新故障按连接器或配置组定位，可在同页恢复对应资源。

选择目录、刷新页面、查看历史不会执行 MCP 业务工具。普通资源申请不新增审批；原 MCP/宿主 ask、deny 和连接器激活规则保留。默认轻量复核、可关闭复核、多 flag 收集和候选即时回显继续有效。

## 共享 IDA 的最小配置

点击“添加资源配置组”，修改实际工具前缀、物理后端 ID 和能力 ID；或在高级 JSON 中保存：

```json
{
  "selection": "auto",
  "waitMs": 300000,
  "profiles": [{
    "id": "ida-shared",
    "label": "共享 IDA",
    "backendId": "ida-local-8745",
    "selectors": ["mcp__ida__*", "mcp__ida_alias__*"],
    "capabilities": ["binary.inspect", "binary.decompile"],
    "roles": ["explore", "verify"],
    "workspaceIds": [],
    "isolation": "exclusive-workflow",
    "maxInstances": 1,
    "maxInFlight": 1
  }]
}
```

- 两个连接别名指向同一个 IDA 时，必须映射到相同 backendId。backendId 是实际共享状态的标识，不能仅根据公开工具前缀判断。
- 独占覆盖“打开样本 → 分析 → 导出”，而不是只锁单次 decompile。A 工作流结束前，B 不能通过同一受管后端切库。
- `workspaceIds=[]` 只表示不额外缩小 Sapper 范围，不能扩大宿主/连接器授权。填原生 Workspace ID 可进一步限制。
- 无状态服务可选 `stateless`，并给已确认的读取工具配置 `effects`。未声明/控制/修改调用独占调用槽；只读调用才按 maxInFlight 并行，防止写者与读者交错。
- `selection=auto` 按意图能力过滤；相同能力组提供多个后端时优先选择负载较低者。`all` 保留作用域内全部已选工具，可能需要同时占用多个后端。
- 活跃/隔离资源存在时不能改变后端映射、隔离方式或删除映射，避免新旧锁域交叉；可调整后续容量，或立即收紧角色/工作区范围。资源策略在独立域保存，不触发整体 Config 变更中断无关任务。

新建题目可展开“本题工具能力”，例如 `binary.decompile, debug.memory.read`。这些只是需求，不是授权。模型也可通过 `sapper_tools` 查询目录、通过 `sapper_resource acquire` 在下一推理边界重新申请能力；宿主先排空与释放旧资源，再申请完整 bundle。WP 阶段只读历史与本地文件，补测应另开求解阶段。

## 核对目标身份

基础串行保护表示“当前宿主内不交错”，不等于已经证明 IDA 打开了本题样本。需要目标认证时，为配置组添加：

```json
{
  "identity": {
    "tool": "mcp__example_ida__database_info",
    "arguments": {},
    "resultPath": "input_path",
    "expected": "{{cwd}}/attachments/chall"
  },
  "targetTools": ["mcp__example_ida__decompile"],
  "effects": {
    "mcp__example_ida__database_info": "read",
    "mcp__example_ida__decompile": "read",
    "mcp__example_ida__open": "control"
  },
  "bindings": {
    "mcp__example_ida__open": { "path": "{{cwd}}/attachments/chall" }
  }
}
```

这些字段添加到上面的 profile 中；**example 工具名和返回路径是说明，不代表你的服务具有这些 API**。先从“工具与模型能力”取得真实名称/schema，并根据真实返回值配置。

`identity` 通过原 ToolRuntime 调用校验工具，不能绕过父会话或当前子 Agent 的授权。`targetTools` 明确哪些操作使用该隐式目标；其他输出仍显示未认证来源。业务调用前后核对身份；明确声明为 control/write 且有参数绑定的换目标操作，可以先按绑定打开本题样本，再核对身份，避免“旧库不匹配，所以无法打开新库”。

`bindings` 是精确原生参数约束，支持 `{{cwd}}`、`{{taskId}}`；Windows 示例中的路径应使用与宿主/服务一致的分隔符与规范路径。框架不会在执行 hook 偷改模型参数。所需参数会作为资源数据提供给代理。

路径字段可包含点分下标；支持 JSON 编码的文本结果，如 `content.0.text.input_path`（text 是可解析 JSON 时），`$` 表示整个值。身份查询、参数映射和读取/写入分类必须基于实际服务语义配置，远端 readOnlyHint 不提供强保证。

## 后端支持独立句柄时

内置提供者 `native-handle` 复用服务真实的创建/校验/关闭 API。以下是高级 profile 模板，工具名、字段和参数都需替换为真实服务接口：

```json
{
  "id": "debug-contexts",
  "label": "独立调试上下文",
  "backendId": "debug-gateway",
  "selectors": ["mcp__example_debug__*"],
  "capabilities": ["debug.control", "debug.memory.read"],
  "isolation": "explicit-handle",
  "providerId": "native-handle",
  "maxInstances": 2,
  "maxInFlight": 1,
  "native": {
    "open": {
      "tool": "mcp__example_debug__open",
      "arguments": {"binary": {"$path": ["{{cwd}}", "attachments", "chall"]}}
    },
    "verify": {
      "tool": "mcp__example_debug__identity",
      "arguments": {"session_id": "{{session}}"}
    },
    "close": {
      "tool": "mcp__example_debug__close",
      "arguments": {"session_id": "{{session}}"}
    },
    "handlePath": "id",
    "argumentPath": "session_id",
    "identityPath": "workspace",
    "expectedIdentity": "{{cwd}}",
    "closeConfirmedPath": "closed",
    "tools": ["mcp__example_debug__read_memory"]
  },
  "effects": {"mcp__example_debug__read_memory": "read"}
}
```

`{{session}}` 是宿主从真实创建结果取得的句柄；`$path` 使用当前操作系统的路径拼接，不执行 shell 模板。代理会得到必须提供的参数绑定，不能换成别题句柄。创建和关闭入口由宿主管理，模型不能绕过生命周期直接重开资源。只有服务返回指定 `closed=true` 才视作确认关闭。

句柄隔离要求**服务实际尊重句柄，且全部业务工具均绑定它**。仅建立两个 HTTP/MCP 连接不符合要求。此适配器也不创建 IDA 进程；不支持句柄的 IDA 继续用独占。`dedicated-instance` 是实例提供者扩展点：第三方扩展须注册真实 worker 的 open/verify/close，提供已注册且父会话可见的原生工具、目标身份和关闭保证，不能选一个提供者名字就宣称进程已隔离。

提供者 verify 若需调用原生 MCP，必须使用框架传入的 invoke，不能递归调用受管工具并等待自己持有的调用槽。

提供者通过插件导出的 `ToolBroker` / `ResourceProvider` 接口注册，接口见 `src/mcp/contracts.ts`；缺少提供者时显示能力缺口，不自动启动未知程序。强隔离仍依赖服务/worker 与其 OS 权限边界。

## GDB / 远程交互

已具备持久会话 API 的 MCP 服务可在 profile 中设置 `interaction`。它是原生工具适配，不是自制网络客户端：

```json
{
  "interaction": {
    "start": {"tool": "mcp__example_io__start", "arguments": {"cwd": "{{cwd}}"}},
    "read": {"tool": "mcp__example_io__read", "arguments": {"id": "{{session}}", "wait_ms": "{{waitMs}}"}},
    "write": {"tool": "mcp__example_io__write", "arguments": {"id": "{{session}}", "data": "{{data}}", "encoding": "{{encoding}}"}},
    "stop": {"tool": "mcp__example_io__stop", "arguments": {"id": "{{session}}"}},
    "sessionPath": "id",
    "outputPath": "output",
    "statePath": "state",
    "outputEncoding": "utf-8",
    "stopConfirmsExit": false
  },
  "handleArgument": "id"
}
```

API 操作名见 [设计](mcp-tool-layer-design.md)。`sapper_interact start` 返回宿主 sessionRef；read/write/interrupt/stop/snapshot 均使用该句柄和 requestId。同一会话按序执行，其他 Agent 不能读取或写入它。

read 以字节 cursor 返回 base64 页，保留 NUL 和任意二进制；空输出不等于 EOF。重复的 write requestId 复用原结果，包含超时/送达不明的失败，不自动重发。内存保留最近 8 MiB transcript，超过范围明确返回 CURSOR_EXPIRED；完整原生输出另有回执产物，不静默跳过内容。

停止操作默认需要 state 确认 eof/crashed；只有服务契约确实保证成功即已退出时，才设置 `stopConfirmsExit=true`。会话清理不确定时隔离相应资源。使用 interaction 时不要同时给同一 profile 配 native-handle，再在它内部创建第二层未定义生命周期；需要组合能力应通过专用提供者实现。

## 测量、诊断与证据

profile 的 `measurements` 可从真实成功结果提取结构化值：

```json
{
  "measurements": [{
    "tool": "mcp__example_debug__measure",
    "claim": "PIE base",
    "valuePath": "base",
    "unit": "address",
    "validity": "resource-epoch"
  }, {
    "tool": "mcp__example_debug__inspect",
    "claim": "gadget offset",
    "valuePath": "offset",
    "validity": "asset",
    "assetDigestPath": "binary_sha256"
  }]
}
```

动态地址/进程状态不能配置成仅文件级有效。可选 `state-revision` 用于更短的状态有效期；未知/控制/写入操作推进 epoch，原读取分类不依赖远端 hints。资源重新分配、重连或重启后，旧动态测量不能成为新前提。文件级测量也必须匹配实际目标资产摘要；从磁盘载入的历史只作参考，不能伪造本轮的新测量。

`sapper_observe list/require` 查询或检查有效范围；infer 只保存标为推断的解释，不能变成实测；diagnose 引用当前工作流实际失败回执，记录保留、失效、重启点和下一能力，不自动重放命令或未知副作用。这些是轻量一致性检查，不会暗中启动 verifier。

每个 MCP 调用留下带 owner、tool schema 摘要、参数/输出摘要、资源版本和来源的最终协议回执。目标未认证的 flag 仍立即显示并可手动提交，但不会自动计为达标，也不能直接晋升 confirmed；配置目标认证或取得真正目标范围的独立证据后再完成。普通文件证据和历史旧格式保持兼容。

任务详情 **工具与资源** 页展示活动/排队与历史快照，**文件** 页可预览所选执行的完整工具回执。目录布局：

```text
.sapper/tasks/<task>/runs/rNNN.json             # children[].tool_broker
.sapper/tasks/<task>/artifacts/tools/<id>.json  # 最终原生输出与协议回执
.sapper/tasks/<task>/observations/<id>.json
.sapper/tasks/<task>/repair-plans/<id>.json
```

legacy 图没有 tasks/<task> 这一层。历史查询只读，WP 保留生成时的证据状态。

## 取消、重启与保证范围

取消后等待工具执行体排空；心跳过期不直接释放资源。远端是否停止不明、关闭未确认或宿主重启遗留的资源先进入 quarantined。界面只有在用户核实实际后端停止并重置后才允许解除隔离。不能在旧调用仍执行时重置锁，也不会关闭用户原有 IDA 或删除附件。fence 计数单独持久化；未支持服务端 fencing 的服务不靠 TTL 强抢。

这套协调只覆盖当前 DSH 进程、经原 ToolRuntime 的工具调用。另一个 DSH 进程、外部脚本或 bash/pwsh 直连网关不在保证范围；要覆盖它们须统一网关/强制出口。完全权限解决审批问题，不会自动带来资源隔离。连接器的 Workspace/Agent 激活仍独立生效。

## 用户实际验收与反馈

建议先用无关、易识别的两个二进制 A/B 验证，再用于比赛：

1. **共享后端**：两题均选同一物理 IDA 组。A 连续查询期间 B 应等待；A 返回的路径/摘要不得变成 B。主会话通过别名切库也应排队。
2. **独立句柄**：仅对真实支持句柄的服务配置 native-handle，开两题观察两个不同句柄；交叉填写句柄应拒绝。资源关闭必须有真实确认。
3. **权限**：未向子 Agent 激活的工具不得因 `mcp__*` 出现；运行中收紧角色/工作区后，新调用应拒绝；不能把已注册显示为业务调用成功。
4. **取消与恢复**：取消排队任务无需启动模型；取消活动调用不应立刻把资源交给 B；重启后原活动资源显示隔离，用户核实后恢复。
5. **目标与速度**：目标不匹配不得把输出当本题事实；未认证候选仍及时回显；none/lightweight 不额外启动 verifier，多 flag 持续收集保持。
6. **交互与测量**：空输出/断开/崩溃状态不同；二进制输入输出完整；重复 requestId 不重复写；重启后旧基址失效，WP/历史查看不执行工具。

反馈可按 [验收报告模板](mcp-tool-layer-validation-report.md)填写。请保留原始记录；无需公开凭据、OAuth token 或网关认证信息。
