# alpha.14：目录选择与创建恢复修复

目标 SDK 保持 DSH `0.2.1-rc.2`。本次仅修复比赛工作台的创建路径，保留 alpha.13 的队列、权限、证据与简报边界。

## 实际原因

1. DSH 的 `uiWorkspace.pickDirectory()` 只服务 native 后端。当前桌面组合为 browse，调用会返回 `directory-picker/unavailable`。alpha.13 的浏览器探针直接返回目录路径，未覆盖这个能力差异。
2. 用户本地 `sapper_workbench` 的两个未完成请求已创建目录、工作区和主会话，但错误均为 `cannot get property "commands" without inject`。面板所属插件仅注入 tools/agents，命令在子作用域注册；根测试 Context 允许的属性读取，在真实插件作用域会拒绝。
3. 重启回归发现存储解码会调整启动参数的字段顺序。旧代码按 `JSON.stringify` 原文比较输入，将同一请求误判为修改目标或目录。

## 修复

- 先通过 `listDirectory` 使用应用内目录浏览；只有返回结构化的 native 能力声明时才调用系统选择器。浏览提供路径跳转、面包屑、主目录、隐藏目录、截断提示、选择和取消；路径直接使用宿主返回值，兼容 Windows 中文和空格。
- 命令执行使用当前作用域的可选服务解析；暂未就绪时保留创建步骤并给出可重试错误。
- 使用统一 launch schema 规范化参数后比较，恢复不受字段顺序影响，同时仍拒绝同 requestId 更改目标或路径。
- 恢复表单优先呈现原请求的模型、preset、权限及已保存错误。目录、工作区、会话与请求 ID 均沿用，不清理用户文件或重建同一道题。

## 验证范围

- 保留原 172 项测试；新增 4 项目录选择回归与 1 项重启恢复回归，总计 177 项。
- 编排集成改为真实 Cordis 插件注入作用域，覆盖四个创建阶段失败恢复，而非仅在宽松的根 Context 下调用。
- 目录测试连接实际 SDK DirectoryPickerController，覆盖 native 成功/取消、browse 中文路径导航/隐藏目录/选择、读取失败后回到主目录与扫描取消。
- 重启测试使用真实 storageDomain/JSON、WorkspaceRegistry、SessionController 和 JSONL；在命令缺失时失败后重启，恢复相同请求并校验目录/工作区/主会话无重复，重复提交完成请求不启动新运行。
- 最终构建浏览器探针通过实际 SDK UiWorkspace 的目录方法及 DirectoryBrowseError、Host DirectoryPickerController 与 Gateway 驱动 browse 选择，再创建题目并打开主会话。模型与目录后端为确定性测试协作者，不宣称真实桌面 OS 选择器人工验收。

执行日志保存在本地忽略目录 `dist/validation/alpha14-*`；安装包为 `dist/sapper-dsh-0.1.0-alpha.14.tgz`。Windows 隔离安装不修改真实 desktop profile，用户原题目和 test4 记录保持只读。

本地结果：177/177 回归通过；最终宿主产物 62/62 集成通过；构建客户端 browse 创建与浅/深色 × 1024/1280/1440 浏览器矩阵通过。类型、构建、官方兼容门禁和打包检查通过。Windows DSH 隔离 profile `sapper-m1-release` 升级安装退出 0，安装后的宿主和客户端哈希与构建一致。四项跨平台 CI 与 GitHub 下载入口在 [进度 issue #1](https://github.com/Luchutong/Sapper-DSH/issues/1) 同步。

| 产物 | SHA256 |
| --- | --- |
| sapper-dsh-0.1.0-alpha.14.tgz | `bceeeedfcc9dc4553fbf7e04129ee2f6125b18639004f71068c3c43eaddd0a5e` |
| lib/index.js | `7fcdede8e2b48e1958369f3bb2dba09735933db127344c31920518c420873931` |
| lib/client.js | `8bd4e0fcc51df7794991acb38a749c13880c93f68a5acd2f17100ef117cd10d0` |

Windows 安装包已复制到 `D:\BaiduSyncdisk\sapper移植\sapper-dsh-0.1.0-alpha.14.tgz`。

## 升级后复验

安装 alpha.14 并重启 DSH。先点击原有 `try it` 的“创建未完成，点击恢复”，确认目标后点击“继续创建”，应复用原工作区并打开主会话。然后新建题目，点击“选择文件夹”，在应用内选中比赛根目录并点“使用此目录”，输入目标后创建。也可手动填写已存在的宿主机绝对路径直接创建。

不要删除 `.sapper-launch.json` 或宿主创建记录来重试，这会丢失请求关联；也不要点击“另建题目”来恢复同一道题。
