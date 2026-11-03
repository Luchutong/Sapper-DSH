# 插件移植经验

## 2026-11-04：全局工具测试无法代表桌面 preset 作用域

用户的 alpha.6 反馈确认 M2 图、历史、召回、KB 与状态通过。M3 r001 的 reason
产出 i002，但 explore 的 request/header 只有 Sapper 工具、structured_output 和
subagent，没有 read/pwsh 等外部能力；随后 explore 和回退 reason 均耗尽 4096 token。
候选/verify 未生成，未新增 confirmed 事实，图完整性正常。此反馈只证明 M2 通过，
不能登记 M3 或独立复核验收通过。

根因是插件从 tools.schemas(child) 枚举后，又用 tools.get(name) 的全局视图过滤。
桌面文件和命令工具位于 preset 祖先作用域，不在全局注册。把过滤后的名称传给
子会话 restrict 会移除这些能力。原测试把 read 注册在全局，因此虽用真实
AgentLoop/SubagentRuntime，仍未覆盖桌面的组合方式。

安装版 ASAR 与同版本 npm 源码均确认：restrictableNames 包含全局和祖先层，
不含子会话自身层。修复必须按 child 的继承作用域查询，保留实际可见的 preset
工具，并与父会话当前可见工具取交集，保留父会话显式 deny 和祖先限制；
不能把父工具复制注册到子会话绕过策略。
M3 子会话单独选 native 呈现，避免 PTC 的入口折叠与结构化输出/原生工具互相冲突，
不改父 preset。测试现在挂载真实 Loader/AgentPresetRegistry，明确断言全局无 read、
父/子 preset 有 read，并覆盖 PTC。

增加取证能力启动检查和 children 工具清单。缺少外部能力时，在模型请求前失败，
而不是让模型反复寻找不存在的工具。max-tokens/子代理未完成结构化结果等故障终止本轮；只有真实
证据复核失败才在剩余预算内探索新路径。默认预算提高到 8192，但预算不能补齐工具，
也不能用增大预算代替作用域修复。回归还证明旧失败 r001 保持原文，原 i002 可在
新运行直接推进，无需重新初始化或手工标记 confirmed。

跨平台并发测试也不能用固定 25ms 延时假定两个子会话一定重叠：Windows 的持久化
耗时可能超过它。改为可取消的同步屏障，等待两个真实 read 调用都到达再放行，
继续断言峰值并发恰为 2、最终活跃数为 0，而不是放宽并发能力/上限断言。

## 2026-11-03：旧 SDK 的绿灯 CI 不代表当前桌面可安装

### 现象

用户安装 `sapper-dsh@0.1.0-alpha.1` 到 DSH `0.2.1-rc.2` 时被拒绝。
`pnpm add` 本身输出 Done，随后 DSH 的安装后校验失败，最终退出码为 1：

```text
Plugin sapper-dsh@0.1.0-alpha.1 is incompatible with dsh 0.2.1-rc.2
requirements: dsh-agent / dsh-llm / dsh-settings / dsh-tools = 0.1.5-rc.1
Exact-version exemption: not active
dsh: restored package.json, pnpm-lock.yaml, and node_modules
```

DSH 已回滚该次安装。下载和依赖安装成功，不等于插件安装成功；应同时检查
最终退出码、兼容校验结果和应用中的激活状态。

### 根因

初始实现以旧 `~/.cache/pkg/...` 中的 SDK 和原计划的 `0.1.5-rc.1` 为依据。
该缓存不是当前桌面进程的依赖来源。实际安装版 `app.asar` 中 Harness 与相关
SDK 为 `0.2.1-rc.2`，Cordis 为 `4.0.5`，Schemastery 为 `3.18.5`。

初版把 SDK peers 精确锁在旧版本，却没有在 CI 中调用 DSH 的官方安装兼容
检查器。原来的 14 个测试只证明旧 API 下的行为，无法证明当前桌面版本兼容。
桌面产品版本 `2.0.19-next` 也不能用来推断 Harness/SDK 版本。

### API 差异与修复

| 旧接口 | 0.2.1-rc.2 的实现 |
| --- | --- |
| ctx.settings.register + settings/updated | Config.volatile()、Config.get()、loader/volatile-update |
| settings.yaml 的独立 namespace | Loader 条目派生 SettingsForms，由配置编辑器写 profile Cordis patch |
| settingsScope.bind | configForms.get('sapper')，由 whileServed 管理页面生命周期 |
| settings.plugin.item | plugins.item；独立设置页使用 settings.section |
| source.kind=plugin + plugin=sapper-dsh | 扩展 MessageSourceMap，source.kind=sapper-dsh |
| 写入只等待 Promise<void> | configForms.set 返回 boolean，false 必须显示拒绝保存 |

修复发布为 `0.1.0-alpha.2`，只声明已适配的 DSH `0.2.1-rc.2`。SDK peers 与
测试依赖同步更新；保留旧包用于追溯，使用新文件名交付，避免重复安装旧包。
没有通过放宽为 `*` 或授予 exact-version exemption 来代替适配。

### 必须保留的发布检查

1. 从桌面应用打开 DSH 终端，执行 `dsh --version`；无法执行时检查当前应用
   实际加载的包元数据。缓存和计划书只是参考。
2. 用目标 SDK 的真实声明和实现编译、测试，核对 host、client、持久化和消息来源。
3. 执行 `pnpm check:compatibility`，使用官方 evaluatePluginCompatibility，且传入
   空豁免表。打包阶段和 CI 都运行相同检查。
4. 回归用例保留 alpha.1 的拒绝结果、alpha.2 的接受结果，以及旧/未知运行时的拒绝。
5. 校验 tgz 中的版本和 SDK peers；记录哈希，确认交付的是新包。
6. Windows/Node CI 与真实 DSH NEXT 安装、激活和交互验收分别记录；M0 桌面门禁
   未完成时继续明确标注，不因构建成功而宣布通过。

精确版本豁免只改变兼容性准入，不会补齐已经删除或改名的运行时 API。

### 本次修复的验证证据

- 真实目标 SDK 下的类型检查、19 项测试、双端构建与包契约检查通过。
- 官方兼容检查使用空豁免表，复现 alpha.1 被拒绝，接受 alpha.2，并拒绝旧/未知运行时。
- Windows 安装版 DSH NEXT 自带 desktop-cli 在临时 DSH_HOME 的 `sapper-compat`
  profile 中成功安装新 tgz，退出码为 0，dependencies 与 bundles 均包含 sapper-dsh。
  使用应用已有 Node/pnpm，在临时目录补齐命令入口；现有 desktop profile 未修改。
  本地证据为 `dist/validation/windows-install-alpha2.log`，关键结果：

  ```text
  + sapper-dsh file:D:/BaiduSyncdisk/sapper移植/sapper-dsh-0.1.0-alpha.2.tgz
  Done in 1.3s using pnpm v11.8.0
  INSTALL_EXIT_CODE=0
  ```

桌面 profile 激活、WebView 页面与字段持久化仍按 M0 检查表验收。

## 2026-11-03：alpha.3 的 M1 首轮审批拒绝与会话权限预设

以下为 alpha.3 历史行为。alpha.4 正常图写入不再额外 ask，无需切换成可交互审批环境；
下述 ask 入口在 alpha.5 仅用于工作区写入模式的逐次审批或显式人工确认点；完全权限自动通过。

用户首次 sapper_init 返回 `the user rejected tool "sapper_init"`，报告无建图且
仍为 uninitialized，符合拒绝分支的预期。会话说明还提到审批提示已禁用。

核对安装版 DSH 0.2.1-rc.2 的 dsh-user-approval：effectivePolicy 为 never 时直接
返回 rejected，工具管线在执行主体前停止。默认 danger-full-access 预设是 never，
workspace-write 预设是 ask。广泛文件访问和允许审批提示是两个独立策略，never
不表示自动批准。手动拒绝与自动拒绝可产生相同工具错误，错误文本不能单独证明来源。

验收应在会话 `/permission` 中选择“工作区内修改”，核对可交互审批，再进行先拒绝、
后明确重试批准的两步。新会话默认权限设置与当前会话切换应分别说明。原始拒绝
结果保留，批准路径单独验收；不通过关闭插件审批或绕过工具写 JSON 来完成本项。

## 2026-11-03：为自动化保留必要约束，避免重复审批

用户完成 M1 验收后指出最终插件应自动完成任务，不应在普通元数据维护中反复确认。
alpha.3 默认每次写图都 ask、连结案与本地 flag 状态也强制询问，是插件策略过宽。
把工作区内数据维护再次当成特权操作，会与 DSH never 策略冲突，阻断已授权任务。

alpha.4 让正常图维护跟随真实会话文件权限自动执行，保留只读、路径、完整性、归属、
比较更新、取消和显式确认点。新增 store.approval，旧 orchestration.requireApproval
不再控制图存储，避免旧 profile 保留的 true 让“只改默认值”的修复失效。

必须同时测两个方向：完全权限/never 下正常链路零审批可完成；read-only 或权限撤销
后不能写。自动化不是忽略平台拒绝，也不是只把默认布尔值改掉。

新增配置页时再次核对真实客户端协议：ConfigForm.set 产生 path=[field]，不会解析
点号字符串。嵌套 store.approval 使用 mutate 和 ['store','approval']，并通过真实
SettingsForms 的路径 mutation 测试，避免仅用手写 UI mock 证明一个错误契约。

## 2026-11-03：完全权限必须覆盖插件自己的确认门

alpha.4 桌面反馈确认图维护功能正常，但受限意图仍需先人工 confirm。用户明确要求
完全权限下默认通过审批，因此 alpha.5 将真实 danger-full-access 视为 Sapper 自身
的持续授权，包括旧 always 配置和 requires_confirmation=true 的意图。

只消除 tools/pre-execute 的 ask 不够：存储层仍会拦住未确认意图。修复必须贯通
平台权限解析、工具策略、存储状态机和 frontier 展示。claim/结案的同一事务记录
confirmed_at 与 confirmation_source=dsh-full-access，保留确认标记便于追溯；只读
frontier 仅表明可执行，不补写记录。不能增加模型可控的 force/skipApproval 参数。

这不会改变 DSH never 的含义；不向平台发出多余 ask，即可避免其自动拒绝。
其他策略的 deny/ask 原样保留。必须用真实 SDK 在 session/always 两种设置下配合
拒绝所有 ask 的答复器测试确认链路，并证明只读、权限撤销、归属和路径保护仍有效。

M2 同时验证预算必须覆盖声明、frontier、历史、recall 和 KB 的总和，而不是每个
分区分别截断；关闭注入要在任何图/KB 读取之前返回。500 节点实盘与读取调用计数
可以验证这两个约束。上游 Python difflib 与 TS bigram 的差异明确写入契约，避免
把 Store/frontier 的兼容测试误解为召回分数完全相同。

## 2026-11-03：M3 必须验证真实子代理生命周期与证据来源

当前安装版 ASAR 和 npm 同版本均提供 SubagentRuntime.startActivation。spec.signal
只覆盖启动取消，不能假定 abort 后已发布子代理就停止；超时、权限撤销与父调用取消
必须 dispose 持有的精确 activation 并等待退出。真实 AgentLoop/SubagentRuntime
测试同时断言最终 live agents 只剩父会话，避免“结果已拒绝但后台还在执行”。

仅用 prompt 要求 explore 不写 confirmed 不够。M3 候选放入 runs，角色工具守卫
阻止写图，普通父工具的 source_intent/conclude 也受存储门禁。晋升需要 explorer 和
不同 verifier 各自成功工具输出的可核对引用，verified=true 本身不能替代证据。

同一候选的 maxVerify 不能只放在单次 run 的内存计数里。引用最早候选 run_id 重试
会重置这种计数；本版将候选子会话与尝试数持久化在意图事务中，并保留回归用例。

父工具可能先因取消产生最终 UI 结果，编排清理仍需持有授权快照至执行体真正退出；
不能在 tools/result 无条件销毁该快照。清理也不绕过已撤销的权限：不能写时保留
running/claimed，待原执行者退出、权限恢复后显式 recover，并记录恢复者。

确定性模型加真实 SDK 可以证明生命周期与状态机；在线模型是否理解证据、正确
判断复现仍需桌面实测。按用户安排 M2/M3 统一验收，不能因本地 CI 通过自动登记
用户已经验收，也不能把 alpha.4 的反馈当作新编排的通过记录。

同版本、同本地 tgz 路径的反复试装可能由包管理器判定 Already up to date，旧安装内容
不会随源归档改动自动替换。本轮隔离安装增加了最终 host 哈希核对，发现旧副本后，
使用带归档哈希的唯一临时路径安装并核对归档/已安装 host。发布产物应保持不可变，
对外更新必须用新版本；不能仅凭安装退出 0 就宣布当前文件已加载。
