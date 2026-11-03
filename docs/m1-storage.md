# M1 存储与工具契约

版本：0.1.0-alpha.4；SDK：DSH 0.2.1-rc.2。M0/M1 已由用户确认验收完成。

## 权威数据与兼容

```text
.sapper/
  project.json            项目目标、状态与 fact/intent/hint/run 计数器
  facts/goal.json          固定终态事实
  facts/f001.json          类型化事实：title / description / doc / kind / data
  intents/i001.json        from[] → to；open / claimed / done / complete
  hints/h001.json          后续编排可用的提示；当前无独立 hint 工具
  flags/ledger.json        由 flag 事实重建的索引，按需创建
  meta.json                可重建的插件写入元数据，format=1
  LOCK/owner.json          TS 写者排他目录锁，记录 pid 与时间
  .transaction.json       仅未完成提交期间存在的事务日志
```

空目录按需创建。项目与节点字段、ID、时间戳格式沿用 Python Store。data 的扁平
标量转成字符串；需要保持数值原始精度/表示时请直接传字符串。已有节点的未知
扩展字段在文档、反向引用与 flag 状态更新时保留。长文在 doc 中，list 操作不展开 doc。

Python 兼容基准为 sapper-v2 revision ba3d3d49a3211b7d26e96cee9df9788506c3e16c。
`tests/reference/` 保留未经改动的 Store/校验代码前缀及 SHA256。golden 测试覆盖
Python 建图 → TS 读取与写入 → Python 校验并修改 → TS 再读，包含类型化 data、
确认/领取/结案、doc、hint、flag 状态和未知字段。Windows 测试 runner 为上游的
fcntl 导入提供一字节锁适配；这不声明与活跃 POSIX 写者并发兼容。

## 写入与恢复

同一进程内，所有 Store 实例按工作区存储路径共享队列。写入前用 mkdir 获取
LOCK，写入后释放；不同 TS 进程争锁会返回明确错误，由调用者稍后重试。
LOCK 不与 Python 的 `.lock` / flock 互通：**TS 与 Python 必须顺序交接写入，
不要让两种实现同时写同一图。** 跨进程读取为 best-effort，读前/后检查 LOCK
与待恢复事务；同进程图读取经过队列。

提交先校验所有目标和数据，再写入事务日志，逐文件以同目录唯一临时文件 + fsync
+ rename 替换，最后移除事务日志。不会先删除目标来替换；Windows 的临时占用
做有限重试。文件编码为无 BOM UTF-8，JSON 文件行结束符为 LF。

多文件写入中断时，日志保留，读操作报告恢复要求，不偷偷改文件。调用
`sapper_init {"action":"recover"}` 后按会话写权限重放全部条目；下一次获准写入也先重放日志。
路径、节点结构、重复事务路径均先验证，非法日志会保留供检查。提交日志落盘后
会完成本次提交，不在取消时停在半个事务；取消后的重试应先查看状态，避免重复建事实。
这提供进程故障后的可恢复提交，不声称跨文件瞬时原子性、网络文件系统事务或
断电级数据库持久性。

进程被强制杀死可能留下 LOCK。只有确认原写者已退出后，才备份图并手动移除
该 LOCK 目录，然后执行 recover；插件不会仅凭锁年龄自动抢锁。不要删除待恢复
事务来绕过错误，损坏日志需先备份并人工检查。

## 校验与状态变更

- 路径须在选定 workspace 内；拒绝根目录、路径逃逸、存储组件中的 symlink/junction。
  这是本地文件系统边界检查，不承诺对抗其他本地进程同时替换路径的竞态。
- 节点 ID 校验后才能拼接文件名，文件名须与节点 id 匹配。
- 状态查询跳过坏节点并报告 warnings，引用断裂/终态不一致进入 integrity；写操作
  要求完整图健康，避免在坏图上追加结果。坏 project.json 直接报错并保留原件。
- ID 分配跳过已占用文件，计数器落后时不会替换旧节点。
- 普通事实字段保持不可变；doc 可以通过带 expected_doc 的比较更新修改。
  结案时会更新结果事实的 source_intent 反向引用，flag 可显式更新 data 中的状态/备注。
- 意图依赖必须存在，goal 不能作为依赖。领取身份来自 DSH 会话 ID，不接受模型指定
  worker/creator。未确认的受限意图无法领取/结案，其他会话不能替领取者结案。
- 创建结果事实和结案意图属于同一可恢复事务；重复结案不会产生孤立事实。
  conclude 到 goal 同时更新项目 completed，不能重复完成。
- M1 是记录证据与任务的工具层，不提供 M3 的 candidate → verify → confirmed 流程。

## Flag 语义

flag 仍是 Python 可读的 `kind=flag` 事实；ledger 是索引。读取时从事实重建，不让
过期索引覆盖 Python 更新。索引缺失或损坏时，读取不写文件，下次 flag 写操作重建。
新增值做 NFKC 与首尾空白归一化，保留大小写；重复 record 返回原条目和 duplicate=true。

新 flag 状态只能是 recorded；submitted / rejected / duplicate / recorded 的变更
通过 sapper_flag update 按会话写权限记录。submitted 是本地图记录的状态，插件不
联网、不推断平台是否接受。source_fact、challenge、captured_at、result 保存来源、
时间与备注；不会因重复捕获自动改变已有提交状态。

## DSH 审批与保留项

默认 store.approval=session，普通写操作跟随 DSH 会话文件权限自动执行。读取真实
sandboxPolicy 的当前 mode 与 workspaceRoot，拒绝只读、越界和缺失权限服务的写入。
在调用前、排队后和提交前检查权限与配置，保留其他 DSH 策略的 deny/ask。

只有显式 requires_confirmation 意图的 confirm，或用户主动设置 store.approval=always，
才由插件发起 ask。普通结案到 goal 和 flag 状态记录不再附加审批。旧
orchestration.requireApproval 不控制图数据，已有配置无需手工删除。
更多迁移、客户端字段协议和自动化边界见 [permissions.md](permissions.md)。

当前只有 workspace 模式。global 和 autoInit 仍保留 schema，尚未执行；初始化
统一显式调用 sapper_init。上下文探针保持只读、目标摘要范围，frontier 与 recall
属于 M2。M0 两字段 project.json 可以继续被摘要探针读取，但不满足完整图校验，
不能直接写入；请保存旧 fixture 并换新测试目录初始化，不进行静默升级。
