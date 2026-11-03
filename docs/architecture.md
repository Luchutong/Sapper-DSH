# 架构与边界

该仓库按 `docs/plan.html` 的五项决定搭建。当前交付是 M0 骨架；接口预留不表示
对应功能已实现。

```text
DSH agent loop                   WebView
  │ agent/pre-step                  │ settings.plugin.item / settings.plugins.tab
  │ tools                           │ settingsScope.bind('sapper')
  ▼                                 ▼
src/dsh-adapter/host.ts           src/client/
  │                                 │
  ├── src/tools/status.ts            └── DSH settings transport
  ├── src/render/context.ts                    │
  └── src/store/project.ts                     ▼
             │                        ctx.settings namespace: sapper
             ▼
  workspace/.sapper/project.json
```

## 目前实现

- Cordis `apply()` 声明 `tools / agents / settings` 依赖，注册 `sapper` schema。
- `sapper_status` 用真实 `defineTool()` 提供有 schema 的只读输出；已启用时注册，
  设置关闭时注销。状态读取不创建图、不初始化 settings 文件。
- `agent/pre-step` 先调用下游 `next()`，保留拒绝和取消结果。只在有工作区、有
  `project.json`、有正常入场消息时增加目标摘要；清除同插件旧 snapshot。
- 上下文固定包含不可信声明；超预算时整段省略目标，不截断单条数据。
- 客户端只读宿主设置镜像，用户主动切换后才调用 `scope.set('enabled', value)`。
- profile、settings.yaml、模型密钥均由宿主管理。

## 后续模块

| 目录 | 当前内容 | 后续职责 |
| --- | --- | --- |
| `store/` | 类型、workspace 路径解析、只读项目摘要 | M1 节点校验、单写者队列、原子替换、兼容与迁移 |
| `render/` | 有预算的目标摘要 | M2 frontier、历史和中英文召回 |
| `tools/` | status + 未注册的工具清单 | M1/M2 写入、文档、flag、KB 与 slash commands |
| `orchestration/` | candidate / verification 接口 | M3 DSH subagent、审批、上限与失败回退 |
| `client/` | 卡片、tab、一个启用字段 | M4 五组配置、诊断 RPC、只读图预览与冲突 UI |

M0 只支持工作区内的存储子目录。`global` 模式、自动建图、完整 frontier、自动
flag 捕获等配置已声明但未执行。存储读取目前只校验 project 的 goal/status，
不声称完成整个 sapper-v2 数据模型验证。

M3 的必要约束：explore 只产出带证据的 candidate，verify 通过后才升级为
confirmed；失败保留开放 intent 并记录 hint。此状态扩展与 Python 兼容性的
处理方案必须在 M1/M3 中明确，不能直接把 candidate 写成普通 fact。

## 构建边界

宿主的 `@deepseek-ai/*` 包保持 external，避免复制 Cordis 服务实例。
浏览器只 external React 与 JSX runtime，它们由 DSH 静态模块表提供。
`dsh.client.inject` 声明客户端运行前需要加载的插件，顶层 `exports['./client']`
指向浏览器 artifact。构建后的 VM 检查验证注册是惰性的，并限制浏览器 require
列表，防止 Node-only 模块意外进入客户端。
