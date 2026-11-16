# alpha.20 工程验证与用户验收边界

目标宿主仅为 **DSH NEXT 0.2.1-rc.2**，插件工程版本 **0.1.0-alpha.20**。

本地完成：

- `pnpm check`：**247/247**，23 个测试文件；类型检查、宿主/客户端构建、官方兼容门禁及最终包检查通过，无版本豁免。
- 最终构建使用 `SAPPER_PACKAGED_HOST=1 SAPPER_BROWSER_PROBE=1` 执行 MCP 与实际 Gateway 工作台用例：**14/14**。包括原生 ToolRuntime/AgentLoop、共享后端/别名、排队后权限拒绝、取消排空/隔离、独立原生句柄、SDK 容量交接、严格 Gateway 策略读写及浏览器工作台探针。
- 资源设置组件检查覆盖只读加载、独立策略保存、可输入多个 selector、解除隔离所需的实际后端确认。`sapper-mcp/1` JSON Schema draft 2020-12 及 **24/24** 正反结构样例通过。
- 日志保存在本地 `dist/validation/alpha20-check.log`、`alpha20-packaged-host.log`、`alpha20-pack.log`；用户原始 `docs/测试结果.txt` 保持未修改、未提交。

这些测试使用确定性模型和模拟服务，证明插件调度/权限/资源接口的行为；**不证明真实 IDA、GDB 或远程网关已实现相同的隔离语义**。按用户安排，不代做实际题目或日常 Windows profile 安装，真实环境由用户验收后汇总报告。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.20.tgz | `6ddb054ae99cbd9bc5894ab0ea2c9187aeb683511792cd65fbba394298b73a74` |
| lib/index.js | `028b8af8f8d2843a3cb058d06d815ffafc5b7abeff71c7447d7ec70951a093a1` |
| lib/client.js | `a862b03c425e3fcf6fc1fe05a64404d87fdde0cc0a4c6c5d77cda0abf33acec7` |

安装包与 `.sha256` 已复制到 Windows `D:\BaiduSyncdisk\sapper移植`，副本摘要一致。此次交付供实际验收，不替换 alpha.19 的 Latest Release；四项跨平台 CI 状态同步 GitHub issue #1。

先阅读 [配置与实测指南](mcp-tool-layer.md)，按 [验收报告模板](mcp-tool-layer-validation-report.md)记录真实作用域、实际工具名/脱敏参数、A/B 目标身份、排队与主会话回显、取消恢复和产物位置。共享 IDA 可直接使用工作流独占；原生句柄并发必须有服务真实支持；专属进程仍需注册真实实例提供者。其他 DSH 进程或 shell 直连不受当前宿主锁保护。
