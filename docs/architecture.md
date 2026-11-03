# 架构与边界

当前交付为 0.1.0-alpha.3 / M1，目标 DSH 0.2.1-rc.2。M0 已获用户验收。
原计划保留在 docs/plan.html，SDK 和实现细节以当前代码与 sdk-contract.md 为准。

```text
DSH agent loop                          WebView
  agent/pre-step                          plugins.item / settings.section
  tools/pre-execute → approval            configForms.get('sapper')
  tools.guard                             Config.set / subscribe
         │                                      │
  src/dsh-adapter/host.ts                src/client/
         │                                      │
  src/tools/ 六个工具                      DSH Config transport
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

启用时注册 status / init / fact / intent / doc / flag 六个工具。写操作默认走
DSH ask 审批；关掉普通写入询问后，confirm、结案到 goal、flag update 仍需审批。
策略链中的已有拒绝保留。guard 和写入前检查阻止审批等待/队列期间关闭插件后的写入。
工具分类只把只读操作标记为可并发；内部存储仍有共享队列。

Store 保留 Python 的事实、意图、文档与 hint 布局。flag 事实为权威记录，ledger
按需重建。多文件提交通过可重放日志恢复；ID 分配、反向引用和项目终态属于同一
事务。完整格式、崩溃与跨进程边界见 [m1-storage.md](m1-storage.md)。

## 上下文与客户端

agent/pre-step 先执行 next，保留拒绝/取消。只在已选择工作区、存在项目目标、
有正常入场消息时附加带预算和不可信声明的目标摘要。每轮移除旧的 Sapper snapshot；
producer-owned source.kind=sapper-dsh，form=snapshot。M1 仍只注入目标，M2 才提供
完整 frontier 和历史/召回。探针检查锁和事务状态，不进行自动初始化或恢复写入。

客户端通过 configForms 读取宿主镜像，只有用户切换后才调用 set。false 显示拒绝
保存；仅打开页面不写默认值。完整表单和图预览为 M4，当前 GraphPreview 是进度提示。

## 模块状态

| 模块 | 当前职责 | 后续 |
| --- | --- | --- |
| store | 校验、workspace 路径、队列、锁、原子 IO、恢复、图与 flag 操作 | global 数据目录策略、显式迁移 |
| tools | 六个 M1 工具与读写分类，按需展开 doc | M2 recall / KB，M3 dispatch |
| render | 有来源/预算的只读目标摘要 | M2 frontier、历史与中英文召回 |
| orchestration | 接口预留 | M3 DSH 子代理、审批、预算、candidate/verify 流程 |
| client | 插件卡片、启用字段、失败提示 | M4 完整配置、诊断与只读图预览 |

workspace 是当前唯一支持的存储模式。global / autoInit 仍为预留配置。
M1 不提供自动探测、网络提交、子代理执行或证据自动验证。

## 构建与验证

宿主为 ESM，SDK 保持 external，避免复制 Cordis 实例。浏览器为
window.__ModuleLoader__.load 注册的 lazy-CJS factory，只引用宿主共享 React。
dsh.client.inject 声明客户端依赖，exports['./client'] 指向客户端产物。

验证包括真实 Loader/SettingsForms、真实 ToolRuntime 审批管线、存储故障与并发、
固定哈希 Python Store 的往返、产物 VM 检查，以及两个独立 Node 写者。Python
仅存在于测试代码，桌面插件不依赖 Python。安装兼容性使用官方检查器、空豁免表，
CI 和打包阶段均执行；各版本的桌面验收分别记录。
