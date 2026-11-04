# alpha.16：repeater 候选类型误标复盘

支持 DSH NEXT **仅 `0.2.1-rc.2`**，与 alpha.15 的 SDK 兼容约束一致。

## 现场结论

只读检查题目 `repeater-20261104T135401-8f00459e` 的运行记录、主会话与子会话日志，发现用户看到的“候选 flag”来自工作台的统一标签。后端实际提交的是普通分析和漏洞候选。

| 主会话事件 | 时间（北京时间，2026-11-04） | 实际内容 | 数据中的类型与阶段 |
| --- | --- | --- | --- |
| seq 15 | 21:55:18 | 附件清点、ELF 架构与保护信息 | `kind=note`，`phase=progress`，`status=unverified` |
| seq 17 | 21:56:45 | 栈溢出与栈泄漏原语分析 | `kind=vuln`，`phase=progress`，`status=unverified` |

这段日志中的 `flag_observations` 为空，没有 `flag-found` 通知或已登记 flag；运行继续推进后续意图。两条分析通过独立复核，表示这些分析结论已复现，不代表比赛目标已完成或已得到 flag。检查时任务仍在运行，后续结果以新增日志为准。

## 原因与修复

工作台“概览”遍历 `result.candidates` 时，只依据 `status` 选用通用 `candidate` Badge；该状态的题目级文案为“候选 flag，尚未复核”。候选集合同时包含 `note`、`vuln` 等类型，展示时缺少了 `kind` 判断。

候选卡片现与主会话共用按类型生成的标签：

| 候选类型 / 状态 | 文案 |
| --- | --- |
| `note` 等普通分析 / unverified | 候选结果 · 尚未复核 |
| `vuln` / unverified | 漏洞候选 · 尚未复核 |
| `flag` / unverified | 未验证 flag · 可先提交测试 |
| 普通结果 / rejected | 复核未通过 |
| `flag` / rejected | flag 复核未通过 |

真正 flag 的即时回显、独立复核和早停流程保留。原候选仍按原始 `kind` 读取，升级后的界面可正确展示现有记录，无需为修正标签重跑题目。

## 验证

- 保留原 181 项测试，新增 5 项真实 Workbench / ResultBody 渲染回归，总计 186 项；覆盖普通分析、漏洞、flag 和拒绝状态，确认读取不会发起任务、修改候选或把非 flag 显示为 flag。
- 最终客户端浏览器探针通过真实 DSH 插槽、Gateway 与宿主详情接口读取持久化的合成 note/vuln 候选，检查二者分别显示普通/漏洞标签，界面没有“候选 flag”。合成数据仅在临时测试目录中创建。
- 类型检查、构建、包兼容门禁、Windows 隔离安装与四项跨平台 CI 按原发布流程验证，结果在 [进度 issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1) 同步。

现场题目和原始会话保持只读，本次检查未停止正在执行的题目，也未将普通分析写为错误 flag。

本地完整检查 186/186 通过；最终构建浏览器探针通过 note/vuln 类型显示、主会话入口、WP 文件及浅色/深色 × 1024/1280/1440 矩阵。类型、双端构建和官方兼容门禁通过。安装包为 `D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.16.tgz`。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.16.tgz | `72d4bb9c7a8289377fffe5ebde441699243112be87b92cd1f091da94d55158d8` |
| lib/index.js | `282622df80c707429c05608135704e68c7a5ea786ee5eadf5b1b38351edc6b4e` |
| lib/client.js | `40b28f5fd5a3cc0f04ffa55342345ba0c40ab2c262f954b2ffe3cc6d486dcd92` |
