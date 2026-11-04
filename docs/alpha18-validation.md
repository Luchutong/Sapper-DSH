# alpha.18：MCP 工具范围与模型推理强度

仅支持 **DSH NEXT `0.2.1-rc.2`**，不声明兼容其他 DSH 版本。

## 原因与修复

原 `external()` 仅对 `exploreTools` / `verifyTools` 做精确字符串匹配；默认名称中没有 MCP 工具，导致父会话可见的 IDA 等能力在子代理范围计算时被排除。增加提示词或输出预算无法补齐这种能力缺失。本次未重新执行 repeater 外部目标，也未改动其日志。

现在在 **设置 → Sapper** 中查询真实 DSH 工具目录，可选择主会话以检查 preset/工作区可见性。探索和复核分别提供名称/描述搜索、MCP 命名前缀分组、精确名称选择、未匹配项和显式保存。仅“注册/父会话可见”表示工具范围，不代表 MCP 网关或业务调用健康。

```yaml
orchestration:
  # 全部父会话可见 MCP；也可以用 mcp__ida__* 或精确 public name
  exploreTools: [read, glob, grep, bash, pwsh, web_search, web_fetch, 'mcp__*']
  verifyTools: [read, glob, grep, bash, pwsh, 'mcp__*']
  reasoningEffort: inherit
  reasoningEfforts:
    reason: inherit
    explore: inherit
    verify: inherit
  models:
    reason: inherit
    explore: inherit
    verify: inherit
```

已有显式工具数组不被升级覆盖，空数组也不会回退到默认；需要在 UI 中明确加入 MCP。只有 MCP 命名空间支持末尾通配，不支持任意正则或 `*`、`read*`。推理强度填写 DSH 适配器返回的真实 ID，不预设 low/high/max 在所有模型上通用。

## 约束与兼容

- MCP 仍必须存在于父会话可见工具集，受当前工作区、preset、宿主权限及连接器治理限制。选中工具不能恢复父会话拒绝的能力；最终 guard 会再次校验。reason 不获得外部取证工具，图写入和递归委派继续由编排器管理。
- 子代理保留原生工具呈现和独立上下文。注册工具变化会更新存活子代理的有限 mask，并在推理边界重新检查；PTC 父会话的呈现方式不变。运行记录保存 selectors、实际 tools/external_tools、模型与显式推理档位。
- MCP 输出经真实 ToolRuntime 成功回执进入原证据链，仍需不同子会话独立取证；不把工具名称、注册状态或 UI 选中当作证据。
- 推理强度优先级：角色显式值 → 插件默认 → 父会话/模型默认。更换模型时 SDK 清除不适用于新路由的继承档位；显式不支持值在子代理请求前以 `SAPPER_REASONING_UNSUPPORTED` 拒绝，不静默猜测。
- 新题目的模型区可选任务推理强度；保存到原模型偏好与启动清单，更换 provider/model 时清除旧档位。已有创建请求仍按原清单恢复。
- 配置修改维持原有运行取消语义，避免在同一运行中混用策略；页面读取和草稿选择不写配置。

MCP 连接的安装、凭据与授权继续由现有连接器管理。本版参考其 [三层治理](https://github.com/duhu2000/dsh-mcp-connector/blob/main/docs/TOOL-GOVERNANCE.md) 和 [按会话启用](https://github.com/duhu2000/dsh-mcp-connector/blob/main/docs/SESSION-TOOL-INJECTION.md) 的范围表达，不引入连接器代码或运行依赖。该连接器的激活按 Agent 隔离，主会话已激活不代表子会话已激活；Sapper 不代替用户启用连接或覆盖其 guard。命名前缀分组基于 Host 的实际公开名称，不反推凭据或原始 Server 身份。

## 验证

保留原 192 项测试，新增 12 项：MCP 独立证据、按前缀选择、角色隔离、父会话拒绝、最终执行时撤权、动态注册、默认/角色推理强度、跨模型继承、无效档位、选择器约束及 UI 持久化路径。能力查询通过正式主客端 Gateway 与 strict codec，使用真实 preset/AgentLoop/SubagentRuntime/ToolRuntime；只读查询不会运行目标工具。

最终构建浏览器探针覆盖实际 settings.section 插槽与 Gateway 工具目录、MCP 分组选择、模型真实档位、新题目推理选择、附件上传、主会话、WP 与浅色/深色 × 1024/1280/1440 布局。模型及 MCP 业务工具为确定性夹具，不声称已完成真实 IDA 网关/反编译调用验收；用户应在连接器中确认服务及范围，并在新题目运行日志检查实际 `external_tools` 与 MCP 回执。

本地完整检查 204/204 通过，类型检查、双端构建及官方兼容门禁通过，无版本豁免。打包宿主的 76 项回归与最终浏览器探针均通过。Windows 临时 DSH_HOME / 隔离 profile 安装退出码 0，安装后宿主、客户端摘要与本地一致，日常桌面 profile 未修改。

安装包已同步到 `D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.18.tgz`。Windows/Linux × Node 22/24 的四项 CI 结果及正式发布同步至 [issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.18.tgz | `cd6eb75e861e713d6589c9e547b8dcbecbcd2c0307f33709453a03bac9bfea8e` |
| lib/index.js | `2a31180c44a1520e510d3fc9d5afda25a5bea6b94f6de2c0740951668a4059f0` |
| lib/client.js | `beb7b00c20088224fc999af6e51f91c35f8ef64cca194c783a6a4aad63e16b81` |
