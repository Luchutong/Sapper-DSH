# M1 验收与权限修复验证

本页保留 alpha.4/M1 验收流程。当前 alpha.5 的完全权限会自动通过显式确认门和 always；
新版行为与步骤请使用 [M2 验收指南](m2-validation.md)。下文审批限制按历史 alpha.4 理解。

M1 已由用户确认验收完成。当前包为 **0.1.0-alpha.4**，运行时 **DSH 0.2.1-rc.2**。
本轮重点验证正常图维护连续自动执行，以及必要约束仍有效。

## 升级

从 DSH NEXT 菜单“打开 DSH 终端”，执行后完全重启：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.4.tgz"
```

“设置 → Sapper → 图写入确认”默认为“跟随会话权限（自动）”。旧配置中的
orchestration.requireApproval=true 不会导致图工具继续逐次询问，无需手工修改旧配置。
sapper_status 的 version 应为 alpha.4、store_approval=session。

普通图写入需要会话文件权限允许工作区写入；“工作区内修改”和默认“完全权限”均可。
“完全权限”附带的审批策略 never 不再影响普通图写入。无需为本轮正常链路切换成
可交互审批模式。只读会话仍禁止写入，插件不会自动提高会话权限。

已有 alpha.3 完整图可直接读取，格式不变。原 M0 两字段 fixture 仍不满足完整图格式，
初始化不会覆盖旧文件。建议为下面的自检创建独立工作区：

```powershell
$workspace = Join-Path $env:TEMP ('sapper alpha4 中文-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $workspace | Out-Null
$workspace
```

在 DSH 中选择该目录并新建会话。领取与结案在同一会话完成，使用工具实际返回的 ID。

## 一次指令完成正常链路

可以直接向模型发送：

> 在当前新建的测试工作区完成一次 Sapper 本地存储自检，连续实际调用工具，不要每一步停下来问我。先查询状态，未初始化则用目标 SAPPER-ALPHA4-LOCAL 和来源 desktop fixture 初始化；创建一条本地主机事实和一条普通意图（requires_confirmation=false），领取意图，再创建带 doc 的结果事实并原子结案。读取 doc，用返回内容作为 expected_doc 更新一次。记录虚拟 flag{SAPPER-ALPHA4-LOCAL}，重复记录验证去重，再把它的本地状态改为 rejected，备注“本地验收虚拟结果，没有网络提交”。最后创建一个完成意图并结案到 goal，输出状态、计数和完整性结果。使用实际返回的 ID，不访问网络、不运行探测命令。若遇到只读权限、现有图冲突或损坏，报告具体原因并停止对应写入。

预期：整个普通链路不弹出 Sapper 的逐次审批，不需要中间人工确认。关键证据：

| 环节 | 预期 |
| --- | --- |
| 初始 status | uninitialized，状态查询不创建图 |
| init | 自动成功，active；同目录再次 init 不覆盖旧图 |
| fact create | 类型化 data 保持兼容，数字保存为字符串 |
| 普通 intent create / claim | 不请求审批，领取者为当前会话 |
| 带 source_intent 的结果事实 | 新事实与意图结案同一事务，重复调用不新增孤立事实 |
| doc get / set | 使用准确 expected_doc；旧值覆盖保存会被拒绝 |
| flag record 两次 | 第二次返回相同 ID、duplicate=true，计数不增加 |
| flag update / 结案到 goal | 自动记录本地状态，无网络提交 |
| 最终 status | completed，store_approval=session，warnings/integrity 为空 |

在 fresh 图上，上述流程通常产生 3 条普通事实（含 1 条 flag）、2 条已结案意图，
open_intents=0；goal 终态事实不计入普通 facts 数。普通意图被 claim 后仍计入
open_intents，只有结案才减少。

## 必要约束回归

以下按需在独立测试图进行，不是正常任务每一步的必经确认流程：

- 切换会话到只读，init / fact / doc 等写入应拒绝，status 仍可读取，不自动请求提权。
- 单独创建 requires_confirmation=true 的意图：claim 在确认前失败，confirm 仍需批准。
  在 never 策略下该 confirm 会被拒绝，原意图保持未确认；普通任务不应设置此标记。
- 用户主动选择“每次写入确认”后，写入才逐次询问。此模式遇到 never 会被拒绝；
  切回“跟随会话权限（自动）”后普通链路恢复。设置切换及重启后值应保持。
- 模拟其他 DSH 策略拒绝，插件不能将其变为允许。审批或执行等待期间撤销文件写权限，
  未提交写入应取消。
- 文档比较更新冲突、意图归属、确认门、坏节点与引用检查、路径/符号链接边界继续生效。
- 关闭/卸载后工具与摘要清理；重启后已有图与启用开关保留。只读查询和打开页面不改图。

## 恢复与开发检查

事务日志恢复和 TS/Python 顺序交接见 [存储契约](m1-storage.md)。不要删除未完成
事务来绕过错误；清理遗留 LOCK 前需确认旧写者已经退出。Python 仅用于开发测试，
桌面用户无需安装。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm check:compatibility
corepack pnpm pack --pack-destination dist
```

本轮自动测试覆盖默认连续写入零审批、真实 SandboxPolicyService 的只读拒绝与
权限撤销、旧配置默认值、手动覆盖与显式确认点，同时保留 Python 往返和两进程写入。
权限策略详见 [permissions.md](permissions.md)。
