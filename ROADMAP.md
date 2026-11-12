# ROADMAP (`agy-context-viewer`)

## 当前阶段

`v1.6.2` 已完成开发、隐私脱敏与双语文档升级（修复「费用与订阅」页 Google AI Ultra 档位与参考价识别、接入 `RetrieveUserQuotaSummary` 的 `5h + Week` 双维度共享额度池、修复模型配额池 `[object Object]` 序列化，并新增脱敏界面预览图库、中英文双语 README 与先行开源项目致谢）。

## 阶段里程碑与验收记录

### 已完成

- [x] **补充脱敏界面截图画廊、重构中英文双语 README 并致敬先行参考项目 (`v1.6.2`)**：
  - 对 8 张真实运行截图完成像素级敏感信息遮盖与 PNG 元数据剥离（存放在 `docs/images/`，并在 [scripts/verify.mjs](./scripts/verify.mjs) 新增 PNG 元数据块自动审计），保持运行时发布包轻量；
  - 重构并拆分 [README.md](./README.md)（简体中文）与 [README_EN.md](./README_EN.md)（English），完整展示菜单栏徽章、四段式悬停卡片、右侧置顶小窗与三大视图，并在文末向立项参考项目 [`elviscjn-cjn/antigravity-context-viewer`](https://github.com/elviscjn-cjn/antigravity-context-viewer) 致敬。

- [x] **修正 Google AI Ultra 订阅识别、家庭组快捷设置及 `5h + Week` 双维度配额池 (`v1.6.2`)**：
  - 修复 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 将宿主内部引擎字段 `planInfo.planName = "Pro"` 误拼接为 `Google AI Ultra · Pro` 且误套用 Pro 档 `$19.99/月` 的问题，现准确显示 `Google AI Ultra`（美区公开标准价 `$249.99/月`），未自定义时明确标注「默认公开参考价（客户端 API 不返回家庭组与账单实付）」，并在自定义表单置顶提供「家庭组共享 / 免额外付费」与「家庭组拼车 / AA 分摊」选项；
  - 接入宿主 `RetrieveUserQuotaSummary` 只读接口（[collector.mjs](./sidecars/dashboard/collector.mjs)、[app.js](./sidecars/dashboard/app.js)、[float_window.mjs](./sidecars/dashboard/float_window.mjs)），同时展示各模型组的 **5 小时滚动限额** 与 **Week 周度档位共享池余量**，并修复 `pool.models` 对象数组拼接导致的 `[object Object]` 与日期折行问题。

- [x] **开源仓库元数据、一键安装默认源与隐私脱敏发布 (`v1.6.1`)**：完成 [plugin.json](./plugin.json)、[install.sh](./install.sh)、[install.ps1](./install.ps1) 与 [README.md](./README.md) 仓库地址配置，支持零环境变量一键安装，并通过全仓隐私脱敏与自动化冒烟检查。
- [x] **优化菜单栏与窗口悬停 Tooltip 排版 (`v1.6.1`)**：针对 macOS 原生 `NSStatusBarButton.toolTip` 约 40 显示列折行宽度，重构 [float_window.mjs](./sidecars/dashboard/float_window.mjs) 的 `formatStatusItemFromSnapshot`，采用四段式空行分组（`\n\n`）、剥离冗长 URL 前缀与双层嵌套括号、将多模型配额池归并为 `Gemini 系列` / `Claude / GPT` 简短标签，并将单行严格控制在 `<= 36` 显示列以内（纳入 [scripts/verify.mjs](./scripts/verify.mjs) 自动断言）。
- [x] **支持顶部菜单栏三档显示内容定制切换 + 切换不同/静止会话自动跟随 (`v1.6.0`)**：升级 [native_float_macos.swift](./sidecars/dashboard/native_float_macos.swift)、[float_window.mjs](./sidecars/dashboard/float_window.mjs)、[collector.mjs](./sidecars/dashboard/collector.mjs)、[index.html](./sidecars/dashboard/index.html)、[app.js](./sidecars/dashboard/app.js) 与 [cli.mjs](./sidecars/dashboard/cli.mjs)，支持在 **当前上下文占比**、**最新生成速度与耗时（均值 / 峰值）**、**5 小时 / Week 额度余量** 三种模式间通过菜单栏右键勾选、看板调色盘抽屉分段开关或 `agy-context menubar [context|speed|quota]` 双向同步切换；同时基于 `annotations/<id>.pbtxt` 的 `last_user_view_time`（含同时间戳确定性解平局与后台子智能体过滤）、`#conv-select` 手动锁定与右侧辅助栏焦点识别，实现切换未发言静止会话时约 `1.5s` 内自动跟随更新。
- [x] **修复安装脚本热升级与宿主 `SidecarManager` 目录扫描竞态 (`v1.5.1`)**：将 [install.sh](./install.sh) 与 [install.ps1](./install.ps1) 的构建暂存目录迁移至系统临时目录，并就地原子替换目标文件，避免宿主 `SidecarManager` 扫描到临时目录后引发工作目录失效。
- [x] **新增 macOS 顶部系统菜单栏常驻图标与右侧置顶小窗双入口 (`v1.3.0` - `v1.5.0`)**：实现原生 macOS `NSStatusItem` + `WKWebView` 零端口内存 IPC 悬浮小窗与菜单栏控制器，并提供 Windows / Linux 跨平台无框小窗回退，支持左键 `<5ms` 秒开 / 收回、右键原生菜单及快捷键 `Cmd+Shift+P` 实时切换置顶。
- [x] **官方规范插件封装、宿主 CSS 隔离与 CLI 全功能支持 (`v1.0.0` - `v1.2.0`)**：按官方规范组织根目录 [plugin.json](./plugin.json)、`assets/`、`skills/`、`sidecars/dashboard/`；将内部 CSS 自定义属性全面隔离至 `--cv-*` 命名空间；提供 `agy-context` 终端彩色看板、`web` 独立浏览器看板及自动化校验与打包脚本。

## 关键入口

- 插件清单：[plugin.json](./plugin.json)
- 菜单栏与悬浮小窗：[sidecars/dashboard/sidecar.json](./sidecars/dashboard/sidecar.json) 、[sidecars/dashboard/float_window.mjs](./sidecars/dashboard/float_window.mjs) 、[sidecars/dashboard/native_float_macos.swift](./sidecars/dashboard/native_float_macos.swift)
- 一键安装脚本：[install.sh](./install.sh)（macOS / Linux）、[install.ps1](./install.ps1)（Windows）
- 自动化校验与打包：[scripts/verify.mjs](./scripts/verify.mjs) 、[scripts/package-release.mjs](./scripts/package-release.mjs)

## 最近验证

- `node scripts/verify.mjs` -- 通过，涵盖 Ultra 档位与家庭组折算、`5h + Week` 双维度配额聚合、全仓文本与 PNG 元数据隐私审计及冒烟测试（2026-11-12 16:18 北京时间）
- `node scripts/package-release.mjs` -- 通过，生成 `dist/context-viewer-v1.6.2.zip` 与 `.sha256`（2026-11-12 16:18 北京时间）
- `./install.sh` + 本机守护进程热更新验证 -- 通过，准确展示 `Google AI Ultra`（`$249.99/月` 参考价）与 `5h + Week` 双配额条（2026-11-12 15:18 北京时间）
