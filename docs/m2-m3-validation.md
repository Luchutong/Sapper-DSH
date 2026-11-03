# M2 / M3 统一桌面验收

当前 alpha.7，目标 DSH 0.2.1-rc.2。M0/M1 已验收，M2 已获本次桌面反馈通过；alpha.6 的 M3 因工具作用域缺陷未通过，
alpha.7 修复后继续完成统一验收。
本页是当前入口，旧 m1-validation.md / m2-validation.md 保留历史流程。

## 直接重跑已有 i002（本次反馈的工作区）

安装下文 alpha.7 后完全重启，选回原 M23 工作区。不要重新 init、复制事实或手工
改 confirmed；旧 r001 保留失败历史，i002 已是 open/ready。直接发送：

> 在当前已有 Sapper 图继续实际调用 sapper_dispatch mode=run，推进 ready 的 i002，不重建图，不手工写 confirmed。随后读取新返回 run_id 的 status 完整记录，检查 children 中 explore/verify 的 external_tools 至少有可用的文件/命令工具（例如 read 或 pwsh），预算 max_output_tokens 与配置一致；候选和复核应各自引用不同子会话的实际成功工具输出。最后查看 i002、结果事实、项目状态与 integrity。不运行 KB 示例、不联网、不提交 flag；若出现工具能力缺失或 max-tokens，保留新运行 ID 和具体错误并停止本轮。

默认 maxOutputTokens 现在为 8192；已有显式 4096 配置会保留。若需要调整，修改既有
id=sapper 条目的 orchestration.maxOutputTokens，例如 8192 或 16384，保留其他字段。
这不改变权限或其他预算。工具清单为空时应报告 SAPPER_M3_TOOL_UNAVAILABLE，不能
以增大 token 预算代替工具修复。r001 是 failed，不需要 recover；只有遗留 running
记录才使用 recover。

## 1. 安装与本地 fixture

从 DSH NEXT 菜单打开 DSH 终端，安装后完全重启：

```powershell
dsh plugin add "D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.7.tgz"
```

应退出 0，无版本豁免。普通 M1 图无需迁移。建议创建独立测试工作区：

```powershell
$workspace = Join-Path $env:TEMP ('sapper M23 ' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $workspace | Out-Null
[IO.File]::WriteAllText((Join-Path $workspace 'sample.txt'), 'SAPPER-M23-PASS-7C42', [Text.UTF8Encoding]::new($false))
$workspace
```

在 DSH 中选中该目录，会话选择完全权限。可保留 store.approval=always 覆盖旧配置
回归，Sapper 不应反复询问。M3 会使用当前配置的在线模型及白名单工具，因此预算
测试以小 fixture 开始。默认并发 2，最多 explore 6 次，不需装 Python 或外部代理 CLI。

## 2. 一次指令完成主链路

把下面指令发给模型，查看真实工具/子代理记录：

> 在当前新测试工作区连续完成 Sapper M2/M3 本地验收，不逐步问我。先 sapper_status，确认 alpha.7、M3-orchestration；未初始化则用目标“独立复核 sample.txt 是否包含 SAPPER-M23-PASS-7C42，并记录可复现证据”及来源 desktop fixture 初始化。实际读取 sample.txt，把实际观察写为标题“中文文件证据”的源事实，doc 附加 DOC-ONLY-M23-9F18；再创建一条普通意图并用一条标题“Local fixture history”的结果事实结案，作为 M2 历史样例。调用 sapper_recall 分别查询“中文文件”和“LOCAL FIXTURE HISTORY”，再查询 DOC-ONLY-M23-9F18，后者不应因只在 doc 中而命中；调用 sapper_kb search 查询“Web 信息收集”，get 首条详情；查看 status 的 graph/frontier。随后实际调用 sapper_dispatch mode=run，让独立 reason/explore/verify 完成剩余验证。不要代替子代理手工写 confirmed 事实，不运行 KB 示例命令，不访问网络、不提交 flag。最后读取实际返回 run_id 的 status 完整运行记录，检查候选与复核分别引用不同子会话中的成功工具输出，查看新增事实、意图与完整性诊断。如果遇到真实权限、缺失服务、坏图或预算限制，报告具体原因与运行 ID。

| 检查项 | 预期证据 |
| --- | --- |
| 安装/状态 | alpha.7 / sdk 0.2.1-rc.2 / milestone=M3-orchestration |
| 完全权限 | Sapper 自身不弹审批，受限意图也可自动确认，来源 dsh-full-access |
| 中英文召回 | 两个标题可命中；DOC-ONLY 标记不因 doc 而召回 |
| KB | 56 条离线知识可用，搜索为摘要，get 展开详情；不会执行示例 |
| reason | 真实独立子会话产出有源事实与成功判据的意图 |
| explore | children.external_tools 有实际取证能力，候选引用成功工具输出 |
| verify | 不同子会话独立调用工具，verified=true 且有自己的证据 |
| 晋升 | 新事实 verification_status=confirmed；source_intent/反向引用一致 |
| 项目终态 | reason 标注 completes_goal 且 verify 确认 goal_achieved 时 completed，否则 active |
| 一致性 | warnings=[]、integrity=[]；没有伪造证据或无证据事实 |

真实复核失败可在剩余预算中提出新路径；工具缺失、max-tokens 或子代理未完成结果会
立即停止本轮，stop_reason 说明原因，不追加 reason 空耗预算。已有任务与新 reason 提议重复
时会明确报错，不能静默重复执行。运行 state=completed 指编排已完成，不等价于
整个项目一定 completed；须看项目状态与独立证据。

## 3. 命令、注入与预算

直接在聊天输入框逐条提交：

```text
/sapper status
/sapper frontier
/sapper graph
/sapper recall 中文文件
/sapper kb kb001
/sapper flag
/sapper runs
```

以上直接返回只读数据，不调用模型、不修改图。`/sapper run` 是启动模型编排的命令，
与上述查询不同；它经过真实 tools.execute / sapper_dispatch 权限管线。不要在已经
completed 的同一图上重复启动，换新测试工作区进行该入口回归。

新会话选中同工作区，要求只根据注入上下文说出目标与已有证据，不调用工具。
如能查看运行时消息，应只有一个 source.kind=sapper-dsh / form=snapshot，带
UNTRUSTED DATA 声明、frontier/近期事实，不自动展开 DOC-ONLY 文档。项目已完成时
ready 可为空；验证待办展示需在尚有开放意图的图上进行。

需要更改 context.scope/maxChars/inject 等配置时，用 DSH profile 配置编辑器修改
既有 id=sapper 条目，保留其他字段，不另建重复条目。完整表单属于 M4：

```yaml
context:
  inject: true
  scope: frontier-history
  maxChars: 1024
  historyFacts: 8
  recallAuto: true
  recallTopK: 5
kb:
  enabled: true
  injectTopK: 3
```

- frontier-history 增加结案历史与已有 hint；goal-only 只保留目标。
- inject=false 后没有新 Sapper snapshot，显式工具和命令仍可用。
- recallAuto=false 关闭图自动召回；kb.enabled=false 独立关闭 KB，injectTopK=0 只关闭 KB 自动注入。
- 500 节点、各 scope/字符预算、关闭注入后零图/KB 读取已有自动回归，不要求手动造图。
- 模型复述只能作辅助证据，优先保留运行时消息与真实工具返回。

## 4. 必测反例：环境改变导致 verify 失败

在另一个新测试工作区准备内容为 `SAPPER-M23-ORIGINAL-A` 的 sample.txt。向模型发送：

> 实际读取 sample.txt 并创建新 Sapper 图和源事实，目标是独立验证原始内容仍为 SAPPER-M23-ORIGINAL-A。先调用 sapper_dispatch mode=reason，选取要核对该原始内容的意图，再 mode=explore 保存候选，记录其 run_id/intent_id。不要在这一步晋升事实。随后由父会话实际把 sample.txt 改写为 SAPPER-M23-CHANGED-B，用于模拟目标在两次观察之间变化；再调用 mode=verify，传刚才候选的 run_id 和 intent_id。验证失败后停止这次实验，不自动创建替代候选。读取运行记录、意图、hint 与 sapper_recall 的失败记录。除 sample.txt 与插件自己的图维护外不改其他文件，不联网。

预期：verify 观察到 B 与候选 A 不一致，返回 false；没有新增该候选的 confirmed
事实，意图 open / worker=null，留下具体失败 hint/last_failure，可召回定位。
同一旧候选最多复核 maxVerify（默认 2）次；反复引用最初 run_id 不能重置预算。
如果真实模型误判通过，保留完整运行与两份输出，作为复核质量缺陷报告，不把状态机
自动测试当作在线模型语义正确性的证明。

## 5. 取消和必要约束

在独立测试图检查：

- 取消正在运行的 dispatch：子代理停止；等待清理后查询运行。工具 UI 可显示 aborted。
- 只读会话拒绝 run/recover 等写入，status/recall 仍可用；workspace-write 的显式审批仍有效。
- 配置/权限撤销或禁用插件时停止子会话；禁用后工具、命令和快照清理。
- 若权限已撤销导致无法写回清理，恢复权限且原执行者已退出后调用：

```json
{"mode":"recover","run_id":"实际遗留的运行ID"}
```

recover 不晋升候选，同进程活跃运行拒绝恢复。它与 sapper_init(action=recover) 的
事务日志重放用途不同。不得靠删除事务或修改事实来制造通过结果。

记录安装结果、主链路 run_id、confirmed 事实、负例失败原因、注入/开关结果与取消
结果，即可一起验收 M2/M3；无需分别重复 M1 存储验收。M4 完整配置页与 M5 最终
迁移/发行验收仍在后续阶段。
