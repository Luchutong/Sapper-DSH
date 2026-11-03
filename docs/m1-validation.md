# M1 桌面验收指南

安装包：sapper-dsh-0.1.0-alpha.3.tgz，运行时 DSH 0.2.1-rc.2。
M0 已由用户确认通过；下面是新版本的存储与写工具验收。所有数据均为本地 fixture，
无需连接目标或提交真实 flag。自动化检查不替代这些桌面交互结果。

## 1. 升级与新工作区

从 DSH NEXT 菜单“打开 DSH 终端”，升级后完全重启应用：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.3.tgz"
$workspace = Join-Path $env:TEMP ('sapper M1 中文-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $workspace | Out-Null
$workspace
```

在 DSH 中选择该目录并新建会话。确认设置页显示 alpha.3。使用新目录是为了保留
M0 的手工两字段 fixture；sapper_init 不覆盖旧图，sapper_status 会校验完整格式。

请在同一会话完成领取与结案测试，worker 身份由会话决定。下面每一行都要求模型
实际调用对应工具，查看调用参数、审批与返回值，避免仅看模型口述。

### 准备可交互的审批会话

在 DSH 会话中输入 `/permission`，选择“工作区内修改”（workspace-write）。当前
DSH 0.2.1-rc.2 安装版的默认预设使用 approval=ask，可以出现审批提示。
会话输入框的权限选择器也可切换当前会话；“设置 → 通用 → 权限”选择的是新会话
的默认权限，修改后需新建会话再测。自定义权限预设以其实际 approval 策略为准。

默认“完全权限”（danger-full-access）采用 approval=never。never 表示需要审批的
操作自动拒绝，**不表示自动批准**。因此即使允许广泛文件访问，Sapper 主动请求
审批的写工具仍会被拒绝。请通过 DSH 会话权限入口启用 ask 后测试批准路径。

首次拒绝预期返回 `Error: the user rejected tool "sapper_init"`。手动拒绝和 never
自动拒绝均可能产生同一错误；仅凭该错误不能区分具体来源。模型所说的“审批提示
已禁用”与 never 行为一致，可在权限选择器核对。拒绝后调用只读 sapper_status，
应仍为 uninitialized；也可在前面的 PowerShell 窗口检查：

```powershell
Test-Path -LiteralPath (Join-Path $workspace '.sapper/project.json')
```

全新测试工作区的预期为 False。切换权限后，明确要求模型重新调用一次相同参数的
sapper_init，并在 DSH 提示中批准。成功后再进行下表第 3 步；不以手工写 JSON
代替工具初始化验收。

## 2. 最小读写链路

| 顺序 | 调用参数 | 预期 |
| --- | --- | --- |
| 1 | sapper_status `{}` | version=alpha.3，milestone=M1-storage，state=uninitialized；没有自动建图 |
| 2 | sapper_init `{"goal":"SAPPER-M1-LOCAL：验证存储","origin":"desktop fixture"}` | 出现写入审批；先拒绝一次，确认没有项目写入，再调用并批准 |
| 3 | sapper_status `{}` | active，facts/intents/flags=0，warnings/integrity 为空 |
| 4 | sapper_fact `{"action":"create","title":"本地主机","description":"本地验收数据，不发起网络连接","kind":"host","data":{"host":"127.0.0.1","port":8080}}` | f001；data.port 以字符串保存 |
| 5 | sapper_intent `{"action":"create","from":["f001"],"description":"验证本地证据写入","requires_confirmation":true}` | i001，open，to=null |
| 6 | sapper_intent `{"action":"claim","id":"i001"}` | 提示需先 confirm，图不产生结果事实 |
| 7 | sapper_intent `{"action":"confirm","id":"i001"}`，再调用 claim | 用户审批后允许确认/领取 |
| 8 | sapper_fact `{"action":"create","description":"本地 fixture 证据","kind":"note","doc":"原始证据第一行\n第二行","source_intent":"i001"}` | f002；i001 同时变为 done，to=f002 |
| 9 | sapper_intent `{"action":"get","id":"i001"}` | worker 为当前会话，结案时间已保存 |
| 10 | 再次重复步骤 8 | 已结案错误，不新增 f003 |

ID 示例基于刚初始化的空图；若之前已写入节点，请用实际返回的 ID。

## 3. 文档、flag 与完成项目

先执行 sapper_doc `{"action":"get","id":"f002"}`，再使用返回的完整 doc 作为
expected_doc 执行 set：

```json
{"action":"set","id":"f002","doc":"补充后的本地证据","expected_doc":"原始证据第一行\n第二行"}
```

应保存成功。使用旧 expected_doc 再保存应拒绝，并保留最近内容。fact/intent list
只返回短信息，doc 长文可单独读取。

依次调用 sapper_flag：

```json
{"action":"record","value":"flag{SAPPER-M1-LOCAL}","source_fact":"f002","challenge":"local-only"}
```

首次返回 duplicate=false、status=recorded，fresh 图中 ID 为 f003。用首尾带空白的
同一个值重复 record，应返回相同 ID、duplicate=true，计数器不增加。

```json
{"action":"update","id":"f003","status":"submitted","note":"本地验收模拟状态，没有网络提交"}
```

此操作需显式审批。随后 list 应显示 submitted。检查工具没有调用网络或平台提交。

可选终态测试：创建依赖 f002 的新意图，再 conclude 到 goal。应出现审批，项目
状态变为 completed，意图状态为 complete。重复结案应拒绝。这里的完成是测试
图的数据变更，不代表自动验证了真实任务。

## 4. 持久化与生命周期

- 完全重启 DSH，在同一工作区新建会话，status 的目标、数量、完整性诊断与重启前一致。
- 关闭 Sapper 后六个工具均消失，后续请求没有 Sapper snapshot；重启后开关值保留。
- 重新开启后六个工具恢复，已保存的图保持原样。
- 读取 status / list / doc 和打开设置页不改变图文件内容；读操作不生成 ledger。
- 模型提出写入时拒绝审批，确认没有对应节点。审批等待期间关闭插件，再同意该次
  请求，guard 应阻止写入。
- 移除插件并重启后，卡片、工具与 hook 清理；已有图保留，重新安装可以继续读取。

## 5. 故障检查与恢复

只在可丢弃测试图的副本中进行。破坏一个事实 JSON：status 应报告 warnings/
引用完整性问题，写工具停止写入；恢复备份后继续使用，插件不会自动修复原证据。

如出现 `.transaction.json`，先检查 LOCK 的 owner。确认写进程已退出后，备份图
并清理遗留 LOCK，随后调用 sapper_init `{"action":"recover"}` 并审批。应重放原事务，
status 恢复可读。禁止用删除事务日志来绕过错误，也不要盲目重复创建事实。

TS/Python 只做顺序交接写入；两种锁不互通。Windows 无需安装 Python即可使用插件。

## 开发检查

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm check:compatibility
corepack pnpm pack --pack-destination dist
```

开发测试需 Python 3，使用固定哈希的上游 Store 进行往返。自动检查覆盖 56 项
用例以及打包后两个独立 Node 写者的争锁/重试，不调用模型，不修改现有 desktop profile。

将验收结果记录到 docs/progress.md 和 GitHub issue #1，包括运行时版本、拒绝审批
是否无写入、六工具链路、持久化和重启结果。不要提交真实凭据或真实 flag。
