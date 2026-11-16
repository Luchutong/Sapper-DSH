# Sapper MCP v1 协议草案

这是 [MCP 工具层设计](../mcp-tool-layer-design.md)的规范化审计对象契约。alpha.20 已使用回执、观测和恢复计划归档，并在运行时校验回执与历史观测；管理 RPC、资源诊断和工具参数使用 `src/mcp/contracts.ts` 中的 DTO，不要求所有内部对象都携带审计 envelope。使用与实际隔离边界见 [实施指南](../mcp-tool-layer.md)。

- [sapper-mcp-v1.schema.json](sapper-mcp-v1.schema.json)：JSON Schema draft 2020-12；九种消息，由 protocol/kind 区分；对象默认拒绝未知字段。
- [sapper-mcp-v1.examples.json](sapper-mcp-v1.examples.json)：24 个结构样例（13 个正例、11 个反例），覆盖九种消息、未分配实例的排队、非文件目标、交互读写、错误证据和推断状态。

示例中的工具名、hash、ID、时间均为合成数据。每个样例独立验证，不是一份完整调用 trace；例如失败样例可单独展示 TARGET_MISMATCH，不表示已提供全部实际失败调用。不能据这些名字假定某个 IDA/GDB MCP 实现具有对应 API。

有 Python jsonschema 的开发环境可以这样检查（不增加插件的 Python 依赖）：

```bash
python3 - <<'PY'
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

base = Path('docs/protocols')
schema = json.loads((base / 'sapper-mcp-v1.schema.json').read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema, format_checker=FormatChecker())
cases = json.loads((base / 'sapper-mcp-v1.examples.json').read_text())['cases']
for case in cases:
    errors = list(validator.iter_errors(case['document']))
    assert (not errors) == case['valid'], (case['name'], errors)
print(f'{len(cases)}/{len(cases)} schema fixtures passed')
PY
```

结构检查不负责实际授权。宿主仍须验证：

- owner 来自当前真实会话，leaseRef/sessionRef 不是可转让权限；主会话 owner 使用 sessionId，不伪造 taskId/runId。schema 修订兼容原来的任务 owner 样例，并接受原生 DSH 命名的 Agent ID。
- 连接器和父会话仍允许工具，schema/策略 revision 未过期，资源真实绑定到目标；绝不按公开名前缀推导资源身份。
- 成功回执属于真实最终成功调用，observation 引用同一目标和有效 epoch；模型推断不提升成实测事实。
- fence 单调且服务实际执行 fencing；不支持时必须排空或销毁 worker，不能 TTL 抢占。
- repair-plan 的 preserve/invalidate 不相交；引用有效且无自动重放未知副作用；时间和输出 cursor 单调。

协议增加可选字段前仍需协商对应 schema revision；v1 使用严格对象，因此未知字段不会自动被旧消费者接受。破坏语义的改动升级 `protocol`，上游 MCP 版本协商仍由连接器单独处理。
