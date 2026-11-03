# 项目进度

更新日期：2026-11-03（Asia/Shanghai）。

当前交付：**alpha.2 桌面安装与状态工具调用已获用户确认；项目目标读取通过，摘要注入已有手工冒烟反馈，M0 启停与界面验收进行中。**
本文件随实现提交更新；GitHub Actions 结果与手工验收分别记录，不能互相替代。

GitHub 阶段跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

| 阶段 | 状态 | 交付 / 下一步 |
| --- | --- | --- |
| 骨架 | 完成 | TS 双端工程、SDK 适配边界、模块目录、56 条 KB、许可、测试、CI、打包与计划文档 |
| M0 技术验证 | 进行中 | 桌面工具注册、空工作区与项目读取获确认；摘要注入有辅助证据，页面、启停/持久化和卸载待验收 |
| M1 存储与工具 | 未开始 | TS writer、队列、原子写、节点校验、flag ledger、Python golden tests |
| M2 上下文与召回 | 未开始 | 完整 frontier、bigram recall、KB 查询与 slash commands |
| M3 编排 | 未开始 | DSH subagent、审批、预算、candidate → verify → confirmed |
| M4 配置页 | 未开始 | 五组完整表单、诊断 RPC、图预览、校验与冲突处理 |
| M5 打包与验收 | 未开始 | 干净 Windows 安装、旧 store 迁移与升级路径 |

## 本轮交付

- `package.json` 的 host/client exports、profile patch、双端构建和固定版本 SDK。
- 宿主工具与 hook，设置关闭/开启/卸载生命周期。
- 客户端插件卡片、“设置 → Sapper”页与启用字段；完整分组表单未实现。
- 事实/意图/候选验证类型接口与计划工具清单；未注册未实现的工具。
- 上游 KB 原样保留，单独保留 MIT 许可与来源说明。
- 原计划 HTML 快照，以及架构、SDK 核对、M0 验收文档。
- GitHub Actions Ubuntu / Windows、Node 22 / 24 检查矩阵与 tgz artifact。

## 本地验证

- TypeScript 类型检查通过。
- 5 个测试文件、19 个测试通过；真实 Cordis/SDK、Loader、SettingsForms 和测试编辑器。
- 官方安装兼容性检查复现 alpha.1 拒绝，并接受 alpha.2 / DSH 0.2.1-rc.2；空豁免表。
- 双端构建通过。
- package 契约检查通过：host import、客户端 factory/插槽与 56 条 KB 资源。
- tgz 打包与内容检查通过，开发安装包写入 dist/（不提交构建产物）。
- Windows DSH NEXT 自带 desktop-cli 的真实隔离安装通过，退出码 0；临时
  `DSH_HOME` / `sapper-compat` profile 的 dependencies 与 bundles 均登记新包。
  使用应用已有的 Node/pnpm，只在临时目录创建 shim，没有授予版本豁免。
  日志：`dist/validation/windows-install-alpha2.log`（本地验证产物，不提交）。
- 本轮没有安装或修改现有 DSH desktop profile，也没有调用模型。

## SDK 兼容修复

用户在当前桌面 DSH 0.2.1-rc.2 安装 alpha.1 时被官方门禁拒绝并回滚。根因是初版
依据旧缓存锁定 0.1.5-rc.1；旧版 CI 没有验证当前安装准入。alpha.2 已升级 SDK、
迁移 volatile Config / configForms / producer 消息来源并增加官方门禁回归。
经验文档：[lessons-learned.md](lessons-learned.md)。

原始计划与早期 CI 属于旧版本，不作为当前桌面通过证据。新包和原始旧包使用不同
文件名交付，M0 的 desktop 界面与生命周期仍待逐项确认。

## 桌面验收反馈

2026-11-03：用户确认修复后已能成功安装，并提供两次实际 `sapper_status` 调用
结果及一次未调用工具的目标回答。记录来源为用户提供的返回内容，未独立采集桌面日志。

| 检查 | 反馈结果 | 结论 |
| --- | --- | --- |
| 宿主工具注册和执行 | plugin=sapper-dsh，version=0.1.0-alpha.2，sdk=0.2.1-rc.2，enabled=true | 通过（用户反馈） |
| 未放入项目数据 | state=uninitialized，goal 为空 | 通过（用户反馈） |
| 放入最小 project.json | state=active，goal=SAPPER-M0-9B31：验证目标摘要注入 | 项目读取通过（用户反馈） |
| 未调用工具回答目标 | 回答相同标记并说明来自本轮 Sapper 运行时上下文 | 摘要注入的辅助证据；原始消息来源仍待核对 |

`state=active` 是读取到的 project.json 状态，不单独作为 pre-step 注入证据。
模型关于自身上下文来源的表述和答对标记属于辅助证据；尚未收到带
`source.kind=sapper-dsh` / `source.form=snapshot` 的原始请求或消息明细。

下一步确认卡片和设置页显示，测试关闭/开启、重启后开关值保留、配置仅修改 sapper
条目、项目文件保持不变及卸载清理；操作见 [验证指南](validation-guide.md) 第 5 节。

## 下一步

验证操作指南：[validation-guide.md](validation-guide.md)。已纠正安装入口：普通
DSH CLI 会拒绝 desktop，需从 DSH NEXT 菜单“打开 DSH 终端”，再执行
`dsh plugin add <Windows 安装包路径>`。专用入口已核对安装版代码，并在临时
profile 中执行安装成功；现有 desktop profile 未修改。

先按 [M0 检查表](m0-validation.md) 在 Windows DSH NEXT 中验证安装、卡片、字段
读写与停用行为。通过后再开始 M1；不要把当前只读项目摘要当成完整 frontier。
