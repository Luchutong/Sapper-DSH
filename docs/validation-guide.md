# 当前骨架如何验证

当前版本是 `0.1.0-alpha.2` / M0，目标 DSH `0.2.1-rc.2`。验证目标是构建、插件加载、状态工具、目标摘要
注入与启用开关。完整事实图写入、frontier、召回与解题编排尚未实现。

## 1. 自动检查

在 WSL 仓库目录执行；这些命令不改 DSH desktop profile，也不调用模型：

```bash
cd /home/luchitong/work/Sapper-DSH
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm check:compatibility
corepack pnpm pack --pack-destination dist
```

预期：19 个测试通过，类型检查与双端构建成功，输出 `Package checks passed`，
同时应出现 `Compatibility gate passed`，生成 `dist/sapper-dsh-0.1.0-alpha.2.tgz`。
最新 Ubuntu/Windows × Node 22/24 结果见仓库 Actions；首次 CI 属于旧 SDK，不能
证明该包可在当前 DSH 安装。

## 2. 使用桌面应用提供的安装入口

在 **DSH NEXT 应用菜单**选择 **“打开 DSH 终端 / Open DSH Terminal”**。欢迎信息
应显示正常环境和 `Profile: desktop`。这里的专用 dsh shim 由 Electron 提供，
可以管理桌面 profile；系统通用 CLI 和 WSL 中的 CLI 不具备这个入口。

先执行 `dsh --version`，核对输出为 `0.2.1-rc.2`。桌面应用版本号（例如
`2.0.19-next`）与 Harness/SDK 版本号不同；兼容性应比较后者。若版本不同，
先更新 SDK 适配与验证，不把版本豁免当作适配结果。

以下为这台机器的路径示例，在上述 Windows PowerShell 终端内运行。复制包到
Windows 临时目录后安装，避免把 Linux 路径直接交给 Windows 包管理器：

```powershell
$source = '\\wsl.localhost\Ubuntu-24.04\home\luchitong\work\Sapper-DSH\dist\sapper-dsh-0.1.0-alpha.2.tgz'
$package = Join-Path $env:TEMP 'sapper-dsh-0.1.0-alpha.2.tgz'
Copy-Item -LiteralPath $source -Destination $package
dsh plugin add $package
```

预期：安装退出码为 0，profile 的依赖中出现 sapper-dsh，随后完全重启 DSH NEXT。
若报 `desktop is managed exclusively by the Electron application`，说明调用的是
通用 CLI；重新从应用菜单打开 DSH 终端。

## 3. 验证客户端和状态工具

插件页面应出现 Sapper 卡片，“设置 → Sapper”显示版本与“启用 Sapper”字段。
只打开设置页不会主动写入默认值。

先创建一个没有 `.sapper` 的测试工作区，并在 DSH 中选择它：

```powershell
$workspace = Join-Path $env:TEMP 'sapper M0 中文验证'
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
$workspace
```

在这个工作区的新会话中要求模型实际调用 `sapper_status`。查看工具返回，而不是
只看模型复述。结果应含：

```json
{
  "plugin": "sapper-dsh",
  "version": "0.1.0-alpha.2",
  "milestone": "M0-scaffold",
  "enabled": true,
  "state": "uninitialized",
  "goal": ""
}
```

若为 `unscoped`，检查会话是否真的选择了本地工作区。

## 4. 验证目标摘要注入

在同一测试工作区写入最小 project fixture。这里显式使用无 BOM 的 UTF-8，兼容
Windows PowerShell 5.1；它只用于当前只读探针，不代表完整 M1 store：

```powershell
$store = Join-Path $workspace '.sapper'
New-Item -ItemType Directory -Force -Path $store | Out-Null
$project = '{"goal":"SAPPER-M0-9B31：验证目标摘要注入","status":"active"}'
[IO.File]::WriteAllText((Join-Path $store 'project.json'), $project, [Text.UTF8Encoding]::new($false))
```

开一个选中该工作区的新会话，发送：“不要读取文件或调用工具，只告诉我当前
工作区的目标。”不要在消息里给出标记值。模型回答目标可作辅助证据；如能查看
请求或消息明细，应确认存在：

- `source.kind = sapper-dsh`、`source.form = snapshot`。
- 内容含 `[Sapper: UNTRUSTED DATA]` 和上述唯一目标标记。
- 每轮只添加一个当前 snapshot。

单凭模型答对不能独立证明注入发生；让它先调用 sapper_status 再回答，也会混入
工具结果中的目标，因此应使用新会话检查。

另开会话调用 `sapper_status`，此时应为 `state: active`，goal 为 fixture 目标。

## 5. 验证开关、持久化与卸载

| 操作 | 预期 |
| --- | --- |
| 关闭“启用 Sapper” | 后续工具列表不含 sapper_status；新轮次没有 Sapper snapshot |
| 重新开启 | 工具重新出现，已有 project 的摘要重新注入 |
| 关闭后重启 DSH NEXT | 开关仍为关闭，证明设置持久化 |
| 观察 project.json | 文件内容不变；当前插件不写图 |

设置变更应持久化到 profile 的 `cordis.patch.yml` 中 id 为 `sapper` 的条目。
DSH 0.2 不再使用旧的 `settings.yaml` 命名空间注册机制。

移除插件也应使用应用打开的 DSH 终端：

```powershell
dsh plugin remove sapper-dsh
```

重启后卡片、工具与注入均不再出现。测试工作区和已有设置数据不会因此自动删除。

逐项记录 DSH 版本、日期、工具返回与必要日志到 `docs/m0-validation.md` 和 GitHub
进度 issue。目前已通过桌面自带安装器的隔离 profile 安装（退出码 0）；上面的
desktop 激活和交互仍需实测，全部通过后才结束 M0。
