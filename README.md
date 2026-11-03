# Sapper DSH

将 [sapper-v2](https://github.com/N1nEmAn/sapper-v2) 的事实图与
`reason → explore → verify` 解题循环移植为 DSH NEXT 桌面插件。

**当前版本：`0.1.0-alpha.2`，项目骨架 / M0 技术验证中。**
目前提供一个真实注册的只读工具 `sapper_status`、读取已有项目目标的
`agent/pre-step` 探针、以及插件自己的客户端插件卡片与 Sapper 设置页。
尚未提供建图、事实写入、flag 记账或子代理编排，不适合当作完整解题插件使用。
已通过 Windows DSH NEXT 安装器的隔离 profile 安装验证；桌面界面验收仍待完成。

`alpha.2` 的目标运行时是 **DSH 0.2.1-rc.2**。`alpha.1` 使用旧 SDK，已确认被
该运行时拒绝安装。修复过程与发布检查要求见
[版本兼容经验](docs/lessons-learned.md)。

## 范围

- TypeScript 引擎；桌面用户无需 Python。
- 工作区 `.sapper/` 是目标持久化格式，M1 用 Python golden store 核对兼容性。
- DSH 管理模型、工具审批、会话与子代理。自动循环默认关闭。
- 保留三层证据文档、frontier、recall、flag 台账与离线 KB。
- 不移植 arena/bench、比赛平台提交、Docker 舰队、tmux 或模型密钥管理。

原始计划在 [docs/plan.html](docs/plan.html)；阶段和验收状态见
[docs/progress.md](docs/progress.md)。
GitHub 阶段跟踪：[issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1)。

## 开发

需要 Node.js 22 或更新版本，以及 pnpm 8.15.4。DSH peers 锁定为 NEXT
`0.2.1-rc.2`；Cordis 为 `4.0.5`，Schemastery 为 `3.18.5`。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm check:compatibility
pnpm pack --pack-destination dist
```

`check` 执行类型检查、测试、双端构建和产物契约检查。测试使用真实 Cordis
与 DSH SDK、Loader、SettingsForms 和测试配置编辑器，不调用模型、不连接目标，
不修改现有 DSH profile。CI 覆盖 Ubuntu / Windows、Node 22 / 24。
`check:compatibility` 使用 DSH 官方安装检查器，打包时也会自动执行；准确的
SDK peers 与测试依赖必须一致，仅声明已经适配的运行时版本。

## 开发包安装

下面是 **M0 手工验收步骤，尚未在 Windows DSH NEXT 中完成验证**。
先在 DSH NEXT 应用菜单选择“打开 DSH 终端 / Open DSH Terminal”，确认欢迎信息
显示正常环境、`Profile: desktop`。这个终端提供桌面应用专用的 dsh 命令；通用
CLI 会拒绝管理保留的 desktop profile，WSL 终端也不是 Windows 桌面终端。

```powershell
# 在 DSH NEXT 打开的终端内执行，换成安装包的 Windows 路径
dsh plugin add "C:\path\to\sapper-dsh-0.1.0-alpha.2.tgz"
```

重启 DSH NEXT 后，在插件页面检查 Sapper 卡片，或进入“设置 → Sapper”切换启用字段。
已有 `.sapper/project.json` 的工作区会注入带不可信声明的目标摘要；没有图时不会
自动建图。`autoInit` 等字段目前只声明 schema，实际功能按路线图交付。
禁用后不再注册 `sapper_status`，并清除本轮消息中本插件的旧 snapshot。

逐步操作见 [docs/validation-guide.md](docs/validation-guide.md)，
完整检查表见 [docs/m0-validation.md](docs/m0-validation.md)。

## 目录

```text
src/
  index.ts                 Cordis 宿主入口
  settings.ts              volatile Config schema 与默认值
  dsh-adapter/             宿主/浏览器 API 边界
  store/                   数据契约、路径边界、只读项目摘要探针
  render/                  M0 目标摘要与字符预算
  tools/                   sapper_status 与后续工具清单
  orchestration/           M3 候选结果/复核接口预留
  client/                  插件卡片、设置页与图预览占位
resources/
  kb/                      56 条原始 KB 条目
  prompts/                 M3 三角色 prompt 草案，尚未注册
  licenses/                上游许可
scripts/                   lazy-CJS 包装与产物检查
tests/                     SDK 集成、配置、预算与客户端测试
docs/                      计划、架构、进度与验收
cordis.patch.yml           profile loader 插入点
lib/                       构建产物，未提交到 Git
```

宿主输出 ESM；浏览器输出以 `window.__ModuleLoader__.load()` 注册的 lazy-CJS
factory。客户端只引用宿主提供的 React 模块，通过 `configForms.get('sapper')`
读写插件 Config；变更由 DSH 写入当前 profile 的 Cordis patch，
没有 Node 文件系统或 shell 依赖。真实 SDK 核对记录在
[docs/sdk-contract.md](docs/sdk-contract.md)。

## 后续工作

M0 Windows 加载验收 → M1 存储与写入工具 → M2 frontier 与召回 → M3 子代理验证循环
→ M4 完整设置页 → M5 打包、迁移与干净环境验收。

项目采用 MIT 许可。知识库来源与上游许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
