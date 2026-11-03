# 插件移植经验

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
下述 ask 入口仅用于用户主动选择逐次审批或显式人工确认点。

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
