# Gemini 修复后的第二轮代码审查

审查时间：2026-11-12 17:54（北京时间）。审查对象为 `main` 上基于 `4256ee30cc72b22bda1437692c922c2574ae5177` 的本地未提交修复，仍标记 `v1.6.2`；不是 GitHub 已发布版本。文件行号对应本轮工作区。

## 结论

第一轮指出的 HTTP 写保护、日期回退、配额 ETag、离线模型字段和版本号截断、非法 URL 等具体复现路径已得到修复，新增行为检查也实际通过。不过，**仍有 4 项 P2 需要处理**，其中配额池归属和非标准响应的待发送 Token 计算直接影响统计正确性。未发现新的、已证实的 P1 问题；这不等于完成所有环境的安全认证。

本次只做审查、隔离验证和文档更新，未修改业务实现，保留 Gemini 的全部未提交改动。未安装插件、修改全局配置、提交、推送或发布。

## 第一轮问题的复查状态

| 原编号 | 复查结论 | 证据与剩余边界 |
| --- | --- | --- |
| R1 | 原问题路径通过 | 两个 HTTP 入口已统一校验 Host、Origin / Fetch Metadata、JSON 类型和令牌；未授权写入被拒绝，正常保存成功。宿主 Sidecar 与原生 IPC 未被强加 HTTP 令牌。 |
| R2 | 原问题路径通过 | 默认 371 天日期窗口、跨年 / 闰年及分页检查通过，重复回退已移除。 |
| R3 | 原问题路径通过 | 配额从 90% 变成 20% 后，会话及历史 ETag 均变化；相同载荷重复强制采集的 ETag 保持稳定。未做真实宿主长时间轮询测试。 |
| R4 | 部分修复 | Gemini / Claude 相同余额不再混池，但同品牌多个池及两个展示入口仍有错配，见 F1。 |
| R5 | 原模型字段问题通过，新增支持分支仍有问题 | 单轮 / 多轮日志模型字段与历史费用一致；扩展支持其他响应类型后，完成轮次的边界未同步，见 F2。 |
| R6 | 原问题路径通过 | 带小数点、括号和多次切换的模型名保留完整。 |
| R7 | 原问题路径通过 | 两个 HTTP 入口对畸形路径返回 400，随后仍能正常响应。 |
| R8 | 编码方案已修正，Windows 实机待验收 | ASCII wrapper + Base64 UTF-8 loader 避免把 Unicode 路径写成 ASCII；macOS 上中文空格路径 loader 的 `--help` / `json` 测试通过，未执行 Windows PowerShell / cmd。 |

“原问题路径通过”只说明本轮所检查的修复分支有效，不表示该模块所有行为都已验证。第一轮报告保留为历史记录，不覆盖其基线和原始证据。

## 尚需处理的问题

### F1 · P2：两个配额展示入口未共用同一套池身份解析

**位置**：[pricing.mjs](../sidecars/dashboard/pricing.mjs)，第 279 至 286、346 至 350 行；候选组打分与排序在第 223 至 247 行。

**触发条件**：同一品牌有多个 quota summary group，需要通过 `modelIds` 或明确的 `poolId` / `groupId` 区分。

**根因与影响**：`groupModelQuotas` 把 `modelId` 放进匹配提示，`resolveModelQuota` 却只传显示名称和规范化名称。因此列表能按 `modelIds` 选中正确组，当前会话会退回品牌匹配，在同分组中按 key 字典顺序选第一个。另一方面，`explicitPoolId` 目前只用于结果分组键，没有用于选择 summary group；显示成两个池，不代表两个池的余额都来自正确来源。

**隔离复现**：

- Carbon 组为 80%，Flash 组为 20%，各自提供不同的 `groupId`、`modelIds` 和对应配置。
- `groupModelQuotas` 的 Flash 池返回 **20%**，`resolveModelQuota('Gemini 3.8 Flash', ...)` 返回 **80%**。同一账号在“费用与订阅”和“当前会话 / 菜单栏”可能显示不同额度。
- 去掉 summary 的 `modelIds`，保留配置 `poolId: 'flash'` 与 summary `groupId: 'flash'`，Flash 池仍被绑定到 Carbon 的 **80%**。

这是用当前代码声称支持的输入结构执行的函数级复现，未确认真实宿主当前是否会返回同品牌多组；不将合成输入描述为用户真实配额。

**建议修改**：统一解析接口，传入完整模型配置。优先使用明确池 ID 和精确模型 ID 关联，再采用唯一且无歧义的家族匹配；多个同分候选应保持未知 / 原始 quotaInfo，不能因排序稳定就认定归属正确。

**验收**：同一模型的列表池与当前会话池始终一致；覆盖同品牌多组、精确模型 ID、只有池 ID、无唯一匹配，以及翻转组顺序的情况。

### F2 · P2：新增 usage 响应被当作已完成轮次，同时又计入待发送内容

**位置**：[collector.mjs](../sidecars/dashboard/collector.mjs)，第 1472 至 1475 行；完成位置记录在第 1325 至 1344 行，待发送边界在第 1545 至 1558 行。

**触发条件**：日志包含已完成的 `PLANNER_RESPONSE`，后面出现带 `usage` / `chatModel.usage` 或顶层 token 字段的其他响应类型。

**根因与影响**：新逻辑已将其他类型的 usage 事件纳入 `turns`，但 `stepMetaMap` 和 `lastTranscriptPlannerArrayIdx` 仍只在 `PLANNER_RESPONSE` 分支更新。最新响应已被用于 `actual`，待发送扫描却仍从更早的一轮开始，把最新轮次已经消耗的用户输入和响应文本再加一次，导致上下文水位偏高和错误预警。

**隔离复现**：构造四条事件：用户输入、`PLANNER_RESPONSE`（100 输入 / 10 输出）、400 个 `a` 的用户输入、`MODEL_RESPONSE`（`usage` 为 1000 输入 / 100 输出，正文为 400 个 `b`）。所有响应都已完成，无后续输入。结果为：

```text
turns = 2
context.actual = 1100
context.pendingTokens = 252
context.pendingStepsCount = 2
context.used = 1352
```

预期 `pendingTokens = 0`、`used = 1100`。该输入用于验证新增泛化分支，并非声称 `MODEL_RESPONSE` 是已核验的宿主标准事件名。

**建议修改**：统一“哪些事件构成已完成模型轮次”的判定和原始数组索引记录，计算待发送内容时复用同一个边界。如果并不打算支持这些事件类型，应收窄新增分支，而不是一半按响应处理、一半按待发送内容处理。

**验收**：普通与嵌套 usage 响应、混合响应类型、失败轮次以及完成后新增用户输入均有明确边界；完成轮次后的真实未覆盖内容才进入 pending。

### F3 · P2：浏览器回退小窗的关闭按钮没有调用后端关闭路由

**位置**：[float_window.mjs](../sidecars/dashboard/float_window.mjs)，第 1385 至 1387 行；调用方 [app.js](../sidecars/dashboard/app.js)，第 2000 至 2008 行。

**触发条件**：Windows / Linux 或无 Swift 原生小窗的回退模式，点击页面上的小窗关闭按钮。

**根因与影响**：注入的 `window.sidecar.closeFloatWindow` 只执行 `window.close()`。前端检测到这个函数后不会走 `POST /api/float-window`，因此新服务的 `onCloseRequest` 永远不会由这个按钮触发。即使浏览器成功关窗，后端端口和 `windowVisible: true` 状态仍然保留；后续 `agy-context float` 按“仍可见”分支关闭旧进程，而不是立即重新打开。若浏览器不允许脚本关窗，按钮也可能没有可见效果。

**隔离复现**：从实际回退 HTTP 页面提取注入脚本，在 VM 中替换浏览器关闭函数与 fetch 为计数桩，调用实际 `closeFloatWindow()`。结果：`window.close = 1`、API 请求数为 0、服务端关闭回调为 0，服务仍可返回 200。没有启动真实浏览器；不同浏览器是否允许 `window.close` 未实测。

**建议修改**：回退模式的按钮先通过已有 `apiFetch` 发送带令牌的关闭请求，再尝试关窗；原生 macOS 的内存 IPC 关闭路径保留。浏览器标题栏关闭导致的生命周期同步可单独考虑，但至少先接通产品现有按钮。

**验收**：通过前端按钮触发关闭，服务端退出且清理自身状态；下一次 `float` 直接打开窗口。当前测试直接 POST 后端只能验证路由，不能证明页面按钮已经接上。

### F4 · P2：守护进程版本未变化，热重载仍会复用修复前的实现

**位置**：[float_window.mjs](../sidecars/dashboard/float_window.mjs)，第 54、303 至 306、341 至 353 行；宿主热重载入口见 [main.mjs](../sidecars/dashboard/main.mjs)，第 164 至 174、199 至 204 行。

**触发条件**：旧版常驻菜单栏已启动，通过源码覆盖 / 宿主 Sidecar 热重载加载新实现，但没有经过会先执行 `float quit` 的 Shell / PowerShell 安装脚本；语言服务地址不变。

**根因与影响**：修复前后 `DAEMON_VERSION` 都是 4。新 Sidecar 启动后调用 `ensure-menubar`，升级条件仅比较内部版本和语言服务地址，随后直接复用存活进程。旧进程已缓存旧 collector / pricing / 前端 HTML，窗口和菜单栏不会因磁盘文件变化自动使用本轮修复，造成内嵌面板已修好、常驻小窗仍显示旧行为。

**隔离复现**：对比 HEAD 与工作区确认内部版本均为 4；执行实际 `controlFloatWindow` 函数，并以桩提供版本 4、相同语言服务地址、存活且开启菜单栏的旧状态。`ensure-menubar` 返回旧 PID，没有请求终止或重建。未操作用户正在运行的守护进程，也未进行真实宿主升级测试。

**建议修改**：此次包含采集、前端和 HTTP 行为变更，应递增内部守护进程代码版本，或使用明确的构建标识驱动重建。这与尚待决定的公开 `plugin.json` 版本升级不是同一件事。现有安装器先退出旧进程的路径不受本问题影响。

**验收**：预置旧守护状态、新 Sidecar 进入 `ensure-menubar` 后重建一次并保留应保留的窗口偏好；已经是当前版本时不反复重启。

## 进一步优化建议

- **测试优先补调用链，不继续堆固定返回值断言。** F1 需要跨两个配额函数的一致性验证；F2 需要“已完成轮次 / 待发送内容”一致性；F3 需要页面按钮到关闭回调的链路；F4 需要上一版常驻进程到新版的迁移场景。
- **收窄新模型切换分支中的旧模型回退。** `collector.mjs:1635-1637` 在切换到未识别的新模型后仍回填上一轮 `modelKey`。探针得到 `model: 'Unlisted Model'`、`modelKey: 'gemini-4-carbon'`。目前前端未直接使用该 key，故作为接口语义优化记录，不另计一个高优先级缺陷；建议未知当前模型保留 `null`，上一轮费用继续明确属于上一轮。
- **保持已记录的待决策事项。** 字体外链、模糊模型映射与价格来源、公开版本和截图更新仍是第一轮 S2 / S4 等建议，未因本轮审查自动获得实施授权。本轮没有重新核验外部价格。
- **Windows 验证应运行真实生成入口。** 当前回归在 macOS 上重新构造 loader 来测试，并没有执行 PowerShell 安装脚本生成的 `.cmd`。代码页问题的主要根因已消除，但报告和 ROADMAP 应继续保留 Windows PowerShell 5.1 / 7、cmd.exe 及中文路径实测边界。
- **离线 ZIP 的在线截图可固定到对应 tag。** 打包器当前把截图地址重写到可变的 `main`。这不会阻塞运行，但旧发布包将来可能显示新版截图；发布时可跟随确定的 tag，提高文档可追溯性。

## 验证记录

环境：macOS、Node.js `v24.14.1`。所有追加探针使用任务临时目录、合成数据或 VM 桩；没有读取真实会话、连接真实语言服务或启动菜单栏。

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify.mjs` | 通过，6 / 6 阶段；初始 34 个文件，文档写入后 17:55 再次通过、35 个文件，覆盖原 R1 至 R8 的现有样例 |
| `node scripts/package-release.mjs` | 通过，20 个文件、约 133.4 KB；仅本地打包 |
| ZIP CRC、SHA-256、安装脚本执行位、README 图片地址 | 独立检查通过 |
| `bash -n install.sh`、`git diff --check` | 通过 |
| 配额身份与两个入口一致性探针 | 复现 F1 的两种错配 |
| 混合响应类型探针 | 复现 F2：1100 实际 Token 被显示为 1352 |
| 回退 HTML 关闭函数探针 | 复现 F3：前端未调用关闭路由 |
| 旧守护进程状态控制流探针 | 复现 F4：内部版本仍为 4，未请求重建 |
| 文档链接、内嵌样例与工作区保护 | 17:55 通过；核对 11 个既有改动文件的 SHA-256 未变化，本轮仅新增报告、更新 ROADMAP |

本轮未再次运行独立 `codex review` CLI：上一轮已确认其服务认证失败，本轮没有修改认证配置。结论来自当前 Codex 会话的实际源码审查及上述验证。

## F1 最小复现

在仓库根目录运行，不读取任何用户数据：

```bash
node --input-type=module <<'JS'
import { groupModelQuotas, resolveModelQuota } from './sidecars/dashboard/pricing.mjs';
const configs = [
  { label: 'Gemini 4 Carbon', modelId: 'MODEL_CARBON', quotaInfo: { poolId: 'carbon', remainingFraction: 0.8 } },
  { label: 'Gemini 3.8 Flash', modelId: 'MODEL_FLASH', quotaInfo: { poolId: 'flash', remainingFraction: 0.2 } }
];
const groups = [
  { groupId: 'carbon', displayName: 'Gemini Carbon', modelIds: ['MODEL_CARBON'], buckets: [{ window: '5h', remainingFraction: 0.8 }] },
  { groupId: 'flash', displayName: 'Gemini Flash', modelIds: ['MODEL_FLASH'], buckets: [{ window: '5h', remainingFraction: 0.2 }] }
];
console.log('pool:', groupModelQuotas(configs, groups).find(p => p.id === 'pool:flash').remainingPercent);
console.log('current:', resolveModelQuota('Gemini 3.8 Flash', configs, groups).remainingPercent);
console.log('explicit ID only:', groupModelQuotas(configs, groups.map(({ modelIds, ...g }) => g))
  .find(p => p.id === 'pool:flash').remainingPercent);
// 当前：20 / 80 / 80；正确结果应一致为 20。
JS
```

建议先处理 F1 / F2 的统计错误，再修正 F3 / F4 的窗口及升级生命周期。原报告所列全部环境验收并未完成，不应将“已有测试通过”写成“所有功能和平台已验收”。
