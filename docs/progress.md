# 项目进度

更新日期：2026-11-03（Asia/Shanghai）。

当前交付：**项目骨架完成；M0 技术验证进行中，Windows 桌面门禁待验证。**
本文件随实现提交更新；GitHub Actions 结果与手工验收分别记录，不能互相替代。

GitHub 阶段跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 / 下一步 |
| --- | --- | --- |
| 骨架 | 完成 | TS 双端工程、SDK 适配边界、模块目录、56 条 KB、许可、测试、CI、打包与计划文档 |
| M0 技术验证 | 进行中 | status 工具、目标摘要 hook、设置卡片/tab 已实现并完成本地验证；Windows 安装/字段持久化未验收 |
| M1 存储与工具 | 未开始 | TS writer、队列、原子写、节点校验、flag ledger、Python golden tests |
| M2 上下文与召回 | 未开始 | 完整 frontier、bigram recall、KB 查询与 slash commands |
| M3 编排 | 未开始 | DSH subagent、审批、预算、candidate → verify → confirmed |
| M4 配置页 | 未开始 | 五组完整表单、诊断 RPC、图预览、校验与冲突处理 |
| M5 打包与验收 | 未开始 | 干净 Windows 安装、旧 store 迁移与升级路径 |

## 本轮交付

- `package.json` 的 host/client exports、profile patch、双端构建和固定版本 SDK。
- 宿主工具与 hook，设置关闭/开启/卸载生命周期。
- 客户端 `sapper` namespace 卡片、Sapper tab 与启用字段；完整设置页未实现。
- 事实/意图/候选验证类型接口与计划工具清单；未注册未实现的工具。
- 上游 KB 原样保留，单独保留 MIT 许可与来源说明。
- 原计划 HTML 快照，以及架构、SDK 核对、M0 验收文档。
- GitHub Actions Ubuntu / Windows、Node 22 / 24 检查矩阵与 tgz artifact。

## 本地验证

- TypeScript 类型检查通过。
- 4 个测试文件、14 个测试通过；真实 Cordis/SDK，内存设置与工具探针。
- 双端构建通过。
- package 契约检查通过：host import、客户端 factory/插槽与 56 条 KB 资源。
- tgz 打包与内容检查通过，开发安装包写入 dist/（不提交构建产物）。
- 本轮没有安装或修改现有 DSH desktop profile，也没有调用模型。

## 下一步

验证操作指南：[validation-guide.md](validation-guide.md)。已纠正安装入口：普通
DSH CLI 会拒绝 desktop，需从 DSH NEXT 菜单“打开 DSH 终端”，再执行
`dsh plugin add <Windows 安装包路径>`。专用入口已核对安装版代码，尚未执行安装。

先按 [M0 检查表](m0-validation.md) 在 Windows DSH NEXT 中验证安装、卡片、字段
读写与停用行为。通过后再开始 M1；不要把当前只读项目摘要当成完整 frontier。
