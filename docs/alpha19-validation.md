# alpha.19：多 flag 收集与可选复核

仅支持 **DSH NEXT `0.2.1-rc.2`**。

## 使用

新建题目选择 **持续收集多个 flag** 或 **收集指定数量**；复核默认 **轻量证据检查**，追求最短路径时可选 **关闭自动复核**。原首个 flag 即停及所有结论独立复核仍可选择。默认值在设置 → Sapper 配置，每题启动清单可以覆盖。

已有任务在概览展开 **调整完成/复核策略并继续**；已停但项目仍 active 时沿用原图、候选与累计计数。主会话快捷命令：`/sapper collect all` 或 `/sapper collect 3`，沿用当前默认复核模式；已完成阶段按原后续任务机制保留历史并重新取证。配置与模型工具参数同步支持 `flag_mode`、`flag_count`、`verification_mode`，显式 `verify` 始终执行独立复核。

## 实现边界

- 早停和目标终态一并按策略约束：first 遵循原流程，count 达到候选数量后立即收尾，all 不因单个 flag 或 verifier 的提前 goal_achieved 而完成整个环境。独立复核的 count 目标终态还需要足够数量的 confirmed flag。
- 每个不同值立即回传，按大小写敏感的原值去重；同一阶段跨运行累计，拒绝结果排除。单次工具输出不再只提取前 16 个值；候选不是比赛平台接受证明，不代替提交。
- lightweight / none 不启动自动 verifier。候选仍需当前探索子会话的成功回执；flag 候选描述须实际存在于所引原始输出，不能只用“某工具成功过”支持虚构值。
- 轻量检查复用已引用的调用；重要结论缺少第二次检查时保留观察并标注不足，不自动补一个完整代理。两个引用若属于同一调用，不算两次；flag 的两次输出还需字面值一致。检查只涉及工具证据完整性，不宣称任意漏洞/凭据语义已经证明。
- 快速观察保存在普通 note 与运行记录中，未标 confirmed。原意图保持兼容的 open/to=null 结构，附 `evidence_completed` / `evidence_fact`，本插件 frontier 排除其自动重做；显式 verify 仍能领取原意图并独立晋升。旧版本或 Python frontier 不理解该新标志，可能重新列出这些意图，运行应使用本版调度。
- 快速完成只结束运行，不伪造项目独立验证完成；`evidence-goal-reached` 与独立 `goal-completed` 分开。源事实、候选、原始证据和历史运行均保留。WP 继承历史 flag_observations，文件快照保留生成时状态。
- query 与执行保持分离；新建请求的策略受同一 requestId 冻结，重复点击/恢复不更换目标或策略。未完成的旧启动清单仍兼容。第一条结果不等待收尾、轻量检查或独立复核，主会话输入可继续使用。

## 验证

保留原独立模式回归，新增多 flag 数量/持续模式、重复去重、原图续跑、手动取消保留已发现值、关闭复核后手动独立复核、轻量双回执、不足回执不隐式补 verifier、重要类型选择、虚构值拒绝、单次 24 个 flag，以及设置/新建请求策略持久化覆盖。

原 M3 确定性测试显式选择 independent 验证旧路径，新增测试明确选择 none/lightweight/selective 验证快速路径。模型/MCP 工具为确定性夹具，不声称验证真实远程目标的 flag 正确性或实测线上模型速度。

最终浏览器探针通过正式 settings.section、主客端 Gateway、Workspace/Session/CommandRuntime 选择多 flag 与关闭复核，并读取实际 project.json 核对策略。保留附件、输入框可编辑、WP、图和浅色/深色 × 1024/1280/1440 检查。完整检查、打包宿主、Windows 隔离安装与跨平台 CI 随发布记录到 [issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

本地完整检查 **221/221** 通过；类型检查、双端构建、包检查与官方兼容门禁通过，无版本豁免。最终打包宿主及浏览器检查 **87/87** 通过；Windows 临时 DSH_HOME / 隔离 profile 安装退出码 **0**，宿主和客户端摘要与本地一致。用户日常桌面 profile、原题目和原始测试日志未修改。

安装包已同步到 `D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.19.tgz`。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.19.tgz | `09253957a1cf58d5ebc342b4e58ef99bafdab517caf6a57beae0e623ea17fd0c` |
| lib/index.js | `26848282ca5dec2b4d20a3445e32ed5a8dcb765b9d5ed2c2901c1f1810e3a5a9` |
| lib/client.js | `b259811a34411c28c5d59dacd6226e7e6e76431463af5a419319a95815088e46` |
