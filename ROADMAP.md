# ROADMAP (`agy-context-viewer`)

## 当前阶段

前三轮审查修复与 `v1.6.3` 基线已提交至本地 `main`（`1a461cb`）；[第四轮报告](docs/CODEX_REVIEW_2026-11-12_FOURTH.md) 确认的 **U1–U3** 三项 P2 组合边界均已完成修复、补齐交叉回归、覆盖安装至本机 `~/.gemini/config/plugins/context-viewer` 并提交至本地 `main`。远端 `git push / tag` 与 GitHub Release 发布仍待明确授权。

## 第四轮审查修复与验收记录（2026-11-13 09:15 北京时间）

- [x] 完成 [第四轮报告](docs/CODEX_REVIEW_2026-11-12_FOURTH.md) 的根因核实、修复与交叉回归收口。
- [x] **U1（P2）对比基准与真实服务端容量健康告警解耦**：在 [app.js](./sidecars/dashboard/app.js) 的 `computeEffectiveWindow` 新增 `serverPct`、`serverRemaining` 与 `isSameAsServer`；存在 `serverBudget` 时，`renderTopCapsules`、`hero-ring-fill`、`ctx-health-pill` 与 `ctx-takeaway` 的告警分级统一锚定真实服务端百分比 `win.serverPct`，并同时展示真实占比与对比基准折算值（正向 190K / 200K + 1M 覆盖维持「临近上限」，反向 190K / 1M + 200K 覆盖维持「运行健康」，同容量覆盖不附带冗余折算提示）。
- [x] **U2（P2）切换模型后隔离跨模型服务端预算**：在 [collector.mjs](./sidecars/dashboard/collector.mjs) 抽离 `isTurnMatchingCurrentModel`，逆序查找与 `currentModelKey` / `currentModelDisplay` 匹配的轮次预算，确保切换至未出轮次新模型或无 `maxContextTokens` 模型时 `budget` 返回 `null`、`budgetSource` 返回 `unknown`，同模型续问或切回曾记录预算的模型时准确恢复对应预算。
- [x] **U3（P2）基础配额与仅含重置时间的多窗口摘要解耦展示**：在 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 为 `buildQuotaPools` 与 `resolveModelQuota` 显式保留 `baseRemainingFraction`、`baseRemainingPercent`、`baseResetTime` 与 `baseResetTimeZh`；在 [app.js](./sidecars/dashboard/app.js) 抽离 `extractQuotaParts` 更新 Tab 1 与 Tab 3，在 [float_window.mjs](./sidecars/dashboard/float_window.mjs) 兼容菜单栏标题与 Tooltip（保留原有遗留单窗 0% 兼容逻辑且 Tooltip 单行 `<= 38` 显示列），在 [cli.mjs](./sidecars/dashboard/cli.mjs) 的 JSON 摘要补充 `basePercent` 并适配终端渲染，显式 5h 百分比摘要仍优先于基础配额。
- **验证覆盖**：U1–U3 全链路与交叉边界回归已合入 [scripts/verify.mjs](./scripts/verify.mjs)（`6 / 6` 阶段通过，37 个源码文件）。Windows / Linux 桌面及 Node.js 18 运行时仍为未实测项。

## 第三轮审查修复与验收记录（2026-11-12 23:03 北京时间）

- [x] **T1（P2）未知配额与单窗口 `weekly` 配额展示修正**：在 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 的 `extractSummaryBuckets` 中保留仅含 `resetTime` 的窗口结构并将缺失 `remainingFraction` 维持为 `null`（不把 `weekly` 混入顶层 `5h` 字段）；在 [app.js](./sidecars/dashboard/app.js)、[float_window.mjs](./sidecars/dashboard/float_window.mjs) 与 [cli.mjs](./sidecars/dashboard/cli.mjs) 移除 `remainingPercent ?? 100` 假值兜底，支持 `5h + weekly`、仅 `5h`、仅 `weekly`（独立展示 `Week 20.0%`）、仅 `resetTime`（显示「余量未知 · 重置时间」且进度条归零）、全缺失（显示「余量未知」/`--%`）与真实 `0%`（显示 `0.0%` 告警色）全矩阵。
- [x] **T2（P2）Language Server 故障降级、过期缓存标识与状态 ETag 联动**：在 [collector.mjs](./sidecars/dashboard/collector.mjs) 的 `getHostUserStatus` 独立维护 `lastGoodHostData` 与结构化 `quotaStatus`（区分 `unavailable`、`error`、`live`、`degraded`、`stale` 五态及 `lastSuccessAt` / `summaryLastSuccessAt`）；单接口或全接口故障保留上次成功数据作参考时显式标记 `stale` / `summaryStale` 与原成功时间，持续故障不覆盖原成功时间，恢复后更新成功时间并清除过期标识；将稳定状态字段纳入 `host.sig` 与 `scanConversation` / `collectTokenHistory` 的 ETag（排除易变墙钟毫秒，确保正常无变化轮询 ETag 稳定而状态跃迁即刻刷新），并在 [index.html](./sidecars/dashboard/index.html)、[app.js](./sidecars/dashboard/app.js)、[float_window.mjs](./sidecars/dashboard/float_window.mjs) 与 [cli.mjs](./sidecars/dashboard/cli.mjs) 同步展示缓存/降级提示。
- [x] **T3（P2）未知模型窗口容量保持未知并与用户对比基准解耦**：移除 [collector.mjs](./sidecars/dashboard/collector.mjs) 与 [app.js](./sidecars/dashboard/app.js) 中无服务端 `maxContextTokens` 依据时的 `256000` 硬编码上限，新增 `budgetSource`（`server` / `unknown` / `user`）；自动模式下保留已知 `usedTokens` 并将 `budget`、`remaining`、`percent` 置为 `null`，UI 与 CLI 明确展示「未知」与「容量未知」（不再误判「运行健康」或「待首轮请求」），用户主动切换 `200K / 256K / 1M` 时明确标注为「用户对比基准（非服务端阈值）」；同时同步修正双语 README 目录树对 `pricing.mjs` 职责的描述。
- **后置建议（未确认，不阻塞当前交付）**：API 费率溯源与可选本地覆盖、跨平台 / Node.js 18 实测矩阵、基于实测的大日志偏移量缓存、按需历史导出 CLI（详见 [第三轮报告](docs/CODEX_REVIEW_2026-11-12_THIRD.md)，无需整体重写 Rust）。

## 第二轮审查确认与 `v1.6.3` 收口记录（2026-11-12 18:50 北京时间）

- [x] **F1（P2）同品牌多配额池身份关联与单模型/列表展示统一**：在 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 抽离统一的 `resolveConfigSummaryGroup` 与 `buildQuotaPools`，使 `groupModelQuotas` 与 `resolveModelQuota` 共用同一池构建结果；按 `explicitPoolId / groupId`（`120`）-> `models / modelIds`（`110`）-> 明确子族词（`90`）-> 品牌词（`70`）-> 第三方兜底（`50`）严格分层，显式池 ID 或 `modelIds` 不匹配时不再回退通用品牌词，同分歧义候选直接返回 `null` 保留原始 `quotaInfo`，消除按字母序误绑其他池的问题。
- [x] **F2（P2）泛化 `usage` 响应轮次判定统一与 `pendingTokens` 去重**：在 [collector.mjs](./sidecars/dashboard/collector.mjs) 抽离统一谓词 `isModelTurnStep`，同步用于 `listRecentConversations`、`scanConversation` 首遍扫描与次遍轮次构建及 `collectTokenHistory`；在每个 turn 记录真实数组下标 `_arrayIdx`（序列化前剥离），基于最近有效轮次精确计算 `lastCoveredArrayIdx` 并跳过报错步骤文本，消除非 `PLANNER_RESPONSE` 泛化响应将本轮输入输出重复累加进 `pendingTokens` 的问题；同时修复切换至未知模型时 `currentModelKey` 误继承上一轮旧 `modelKey` 的边界问题。
- [x] **F3（P2）浏览器回退小窗关闭按钮同步通知后端退出**：在 [float_window.mjs](./sidecars/dashboard/float_window.mjs) 的 `createFallbackHttpServer` 桥接脚本中，将 `window.sidecar.closeFloatWindow` 升级为读取 `<meta name="cv-csrf-token">` 发送鉴权 `POST /api/float-window` 后再调用 `window.close()`，并在 [app.js](./sidecars/dashboard/app.js) 同步 `await` 关闭链路，确保点击回退小窗关闭按钮后服务端进程退出并清理 `float_window_state.json`。
- [x] **F4（P2）守护进程版本升级与源码构建指纹自愈**：在 [float_window.mjs](./sidecars/dashboard/float_window.mjs) 将 `DAEMON_VERSION` 升至 `5`，并对 7 个核心运行时与前端打包文件计算确定性 SHA-256 指纹 `DAEMON_BUILD_ID`；`ensure-menubar` 与 `refresh-session` 检测到旧版本或旧指纹守护时自动终止重建，完整保留既有 `windowVisible`、`pinned` 与 `menubarMode` 偏好，已是最新指纹时零重启复用。
- [x] **附加细节与全链路测试补齐**：将 [scripts/package-release.mjs](./scripts/package-release.mjs) 打包 ZIP 内 README 重写的在线图片基址由 `main` 改为对应版本 tag `v<version>`；在 [scripts/verify.mjs](./scripts/verify.mjs) 补齐 F1–F4 真实调用链行为回归（双 Gemini 池 `scanConversation` -> `formatStatusItemFromSnapshot`、`MODEL_RESPONSE` 完成轮次与追加未发送 `USER_INPUT` / 未知模型切换、回退 HTML 桥接 + `app.js` `#btn-float` 点击关闭、真实子进程守护升级与偏好保留）。

## 本次审查确认与修复进度（2026-11-12）

- **第一轮 8 项修复实现记录（第二轮验收与未完成项见上）**：
  - [x] **R1（P1）本地 HTTP 写接口授权边界**：在 [collector.mjs](./sidecars/dashboard/collector.mjs)、[main.mjs](./sidecars/dashboard/main.mjs)、[float_window.mjs](./sidecars/dashboard/float_window.mjs) 与 [app.js](./sidecars/dashboard/app.js) 为 `standalone` Web 与浏览器回退小窗双 HTTP 入口统一接入 `Host` 白名单、敏感路由 `Origin` / `Sec-Fetch-Site` 校验、`POST` 强制 `Content-Type: application/json` 与进程级随机令牌 `X-CV-Token`（`timingSafeEqual`），保持官方 `sidecar_sdk` 与 macOS 原生内存 IPC 零额外请求头影响。
  - [x] **R2（P2）日历热力图日期回退修复**：移除 [app.js](./sidecars/dashboard/app.js) 中重复的第一次 `startSun.setDate` 回退，抽离 `computeHeatmapDateWindow` 按 `53 * 7`（`371` 天）精确对齐周日与周六并修正翻页步长与区间标题（`2026-11-12` 现正确覆盖 `2025-11-09 至 2026-11-14`）。
  - [x] **R3（P2）配额与状态变化纳入内容 ETag**：在 [collector.mjs](./sidecars/dashboard/collector.mjs) 为 `getHostUserStatus` 计算稳定内容签名 `sig`，并对 `scanConversation` 与 `collectTokenHistory` 的完整稳定业务载荷（含 `quotas` / `modelQuotas`、`planStatus`、来源拆分与费用归因，排除易变扫描时间戳）生成 SHA-1 ETag。
  - [x] **R4（P2）配额池稳定身份分池**：重构 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 的 `matchQuotaSummaryGroup` 与 `groupModelQuotas`，按显式池 ID -> 确定性计分的 `summary` 组身份 -> 模型家族键分层聚合，杜绝不同品牌因相同余额 / 重置时间或缺失 `quotaInfo` 被合并，且不受 `quotaSummaryGroups` 顺序影响。
  - [x] **R5（P2）离线会话与全局历史模型计费统一**：在 [collector.mjs](./sidecars/dashboard/collector.mjs) 抽离共用 `extractStepModel` 与 `extractStepUsage`（兼容 `input_tokens`、`chatModel.usage`、`usage`），无语言服务且无模型切换提示文本时，单会话与全局历史识别一致的模型与 API 参考费用。
  - [x] **R6（P2）模型版本号小数点保留**：修正 [collector.mjs](./sidecars/dashboard/collector.mjs) 的 `parseModelSettingFromText` 终止条件，仅在句末句号（`\.(?=\s|$|<)`）、换行或标签处截断，完整保留 `Gemini 3.8 Flash`、`Gemini 3.1 Pro (High)`、`Claude Opus 5.5` 等带小数点及括号档位名称。
  - [x] **R7（P2）畸形请求 URL 防崩溃保护**：在 `guardLoopbackRequest` 与双 HTTP 服务顶层异常捕获中拦截 `//[`、`//evil`、反斜杠及非法 URL，统一返回 `400` 且保持进程存活。
  - [x] **R8（P2）Windows 非 ASCII 路径命令入口**：重写 [install.ps1](./install.ps1) 的命令入口生成逻辑，改为纯 ASCII 的 `agy-context.cmd`（`"%~dp0agy-context-loader.mjs"`）配合 UTF-8 Base64 解码的纯 ASCII `agy-context-loader.mjs`，规避 `Set-Content -Encoding ASCII` 损毁中文路径及 Windows 代码页 / BOM 兼容问题。
- **已同步落地的维护优化（S1–S7 全量完成）**：
  - **S1**：[float_window.mjs](./sidecars/dashboard/float_window.mjs) 子进程早退即刻中断等待（消除无 `swiftc` 时 15 秒空等）并返回明确的 `xcode-select --install` 诊断提示；[install.sh](./install.sh) 与中英文 README 补齐 Swift 工具链前置说明及 Windows / Linux 浏览器小窗能力差异。
  - **S2**：移除 [index.html](./sidecars/dashboard/index.html) 中全部 Google Fonts `<link>`，改用宿主注入字体与本地系统字体栈（[styles.css](./sidecars/dashboard/styles.css)），并在 [scripts/verify.mjs](./scripts/verify.mjs) 强制校验 `index.html` / `styles.css` 零外部 `http(s)://` 资源链接。
  - **S3**：[install.ps1](./install.ps1) 补齐源文件完整性预检、`sidecar.json` 末尾重命名替换、卸载时清理 `agy-context-loader.mjs` 与保留偏好提示；中英文 README 准确区分就地热更新与保留 `settings_v1.json`。
  - **S4**：收紧 [pricing.mjs](./sidecars/dashboard/pricing.mjs) 的 `normalizeModelId` 为仅精确匹配已知代际版本；未知或历史代际名称（如 `Claude 3.5 Sonnet`、`Gemini 1.5 Flash`）返回 `null` 归入 `unsupportedModel` 未定价请求（保留真实显示名并在混合模式下按基准均价折算），并在 [scripts/verify.mjs](./scripts/verify.mjs) 增加代际边界断言。
  - **S5**：收窄 [scripts/verify.mjs](./scripts/verify.mjs) 与双语 README 中关于模式检查的表述，区分常见敏感模式 / PNG 文本块检查与完整安全审计。
  - **S6**：在 [scripts/verify.mjs](./scripts/verify.mjs) 新增完全隔离目录（自动清理、零触碰 `~/.gemini`）的 R1–R8、S2 / S4 与 F1–F4 行为回归测试套件。
  - **S7**：将 [plugin.json](./plugin.json)、[index.html](./sidecars/dashboard/index.html)、[cli.mjs](./sidecars/dashboard/cli.mjs)（动态读取 `plugin.json`）与双语 README 统一升至 `v1.6.3`；执行 `./install.sh` 完成本机就地升级与菜单栏守护热接管；使用隔离合成样本通过无头 Chrome 真实渲染重拍并脱敏剥离元数据生成 `docs/images/usage-trends.png`（`2025-11-09 至 2026-11-12` 多级热力格子与区间汇总正常显示）。
- **待触发外部动作（暂未执行）**：尚未执行 `git add / commit / tag / push` 及 GitHub Release 上传。
- **未覆盖环境说明**：本机验证环境为 macOS + Node.js `v24.14.1`（已完成本机 `./install.sh` 覆盖安装、菜单栏守护运行与 Chrome 无头渲染核验）；尚未在 Windows PowerShell 5.1 / 7 + `cmd.exe`、Linux 桌面环境及 Node.js 18 最低版本实机运行。

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

- `node scripts/verify.mjs` -- 通过（6/6 阶段，检查 37 个源码文件，当前版本 `v1.6.3`），覆盖清单与语法、敏感模式与 `docs/images/*.png` 元数据块检查、零外部静态链接（S2）、精确模型代际（S4）、CSS 隔离及 R1–R8、F1–F4、T1–T3、U1–U3 全部全链路与交叉组合回归（2026-11-13 09:15 北京时间）
- `./install.sh` -- 通过，本机 `~/.gemini/config/plugins/context-viewer` 已就地同步含 U1–U3 修复的 `1.6.3`（`DAEMON_BUILD_ID` 自动触发菜单栏守护热升级，2026-11-13 09:15 北京时间）
- `node scripts/package-release.mjs` + `(cd dist && LC_ALL=C shasum -a 256 -c context-viewer-v1.6.3.zip.sha256)` + Python `zipfile` 独立校验 -- 通过，生成 `dist/context-viewer-v1.6.3.zip`（`139.6 KB`，20 个文件，不含 `docs/`，CRC 无损，包内 README 图片地址已重写至 `v1.6.3` 版本 tag，2026-11-13 09:15 北京时间）
- `bash -n install.sh` 与 `git diff --check` -- 通过（2026-11-13 09:15 北京时间）
