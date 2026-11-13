# 第四轮代码审查：T1–T3 修复后的组合边界

审查时间：2026-11-12 23:23（北京时间）。对象为 `main` 分支、基于 `4256ee30cc72b22bda1437692c922c2574ae5177` 的本地未提交 `v1.6.3`；行号对应本轮工作区。

## 结论

第三轮 T1–T3 的原始复现路径已修复，现有验证脚本全部通过。本轮额外验证组合输入后，**仍确认 3 项 P2**：用户比较基准覆盖健康判断、切换模型后沿用旧模型容量，以及部分摘要遮蔽已知基础配额。未发现新的已证实 P1。

这些问题与前轮修复涉及的数据语义直接相关，不是新增功能要求；不将每项都认定为本版新引入的回归。本轮仅审查、隔离验证、打包及更新文档，未修改业务源码、测试源码、宿主配置或执行安装、提交、推送和发布。

## 前轮验收结果

| 前轮项 | 本轮确认 | 尚存边界 |
| --- | --- | --- |
| T1：未知配额 / 单独 weekly | 缺值不再显示 100%；独立 weekly、reset-only、真实 0% 的既有回归通过。 | 基础配额有值、summary 仅有 reset 的组合见 U3。 |
| T2：断连仍显示实时配额 | `quotaStatus` 区分连接失败、降级、缓存与恢复；状态跃迁更新 ETag，持续失败保留成功时间；既有 mock LS 回归通过。 | 本轮未在这一修复范围内确认新的问题；未做真实宿主长时间运行验证。 |
| T3：未知容量默认 256K | 无服务端容量的离线日志保持未知；有服务端容量的自动模式、无服务端容量的用户基准模式均通过。 | “有服务端容量 + 用户基准”和“切换模型 + 旧 metadata”见 U1、U2。 |

## U1 · P2：已有服务端容量时，用户基准会错误改变健康判断

**位置**：[app.js](../sidecars/dashboard/app.js) 第 492–505 行的 `computeEffectiveWindow`；第 607–614 行的健康标签；第 702–719 行的解释文案。

**触发条件**：服务端容量已知，同时用户选择不同的 200K / 256K / 1M 对比基准。

**复现**：用项目现有的渲染 harness 执行真实 `app.js`，输入 `context.used = 190000`、`budget = 200000`、`budgetSource = 'server'`、`percent = 95`、无请求错误；再设置 `state.ui.budgetOverride = 1000000`。

```text
服务端真实占比：95%
对比基准占比：19.0%
健康标签：运行健康
解释：窗口健康（已用 190.0K / 1.00M）。上下文容量充裕……
```

**原因与影响**：`pct` 已根据用户基准计算，但“只按对比基准描述”的分支要求 `win.isOverridden && !win.serverBudget`。一旦存在服务端容量，反而退回常规健康判断，使用比较值宣称真实窗口健康。即使其他位置显示了服务端默认容量，也不能抵消这条相反的告警结论；真实 95% 的容量压力被掩盖。

**建议**：分别保留服务端占比与用户基准占比。服务端容量存在时，健康提示依据服务端值；比较图可以继续使用用户基准并明确标注。若选择全部显示为比较态，也不能输出真实容量“充裕”的结论。无需新增配置。

**验收**：服务端 200K、已用 190K、用户基准 1M 时仍提示真实容量接近上限；反向组合也不能把较小的用户基准当成真实容量耗尽。覆盖自动模式、无服务端容量的比较模式及比较值恰好等于服务端值。

## U2 · P2：切换模型后，新模型继承上一模型的服务端容量

**位置**：[collector.mjs](../sidecars/dashboard/collector.mjs) 第 1761–1773 行已判断 `switchedAfterLatestTurn` 并更新模型；第 1808–1814 行仍直接使用 `latestTurn` / `latestValidTurn` 的预算。

**触发条件**：模型 A 完成一轮，随后通过 `USER_INPUT` 模型设置事件切到模型 B；B 尚无新的 generator metadata。

**隔离复现**：

1. 合成日志中，步骤 2 为 `Gemini 3.8 Flash` 的完成响应，输入 100000、输出 1000；mock `GetCascadeTrajectoryGeneratorMetadata` 仅为步骤 2 返回 `maxContextTokens: 200000`。
2. 步骤 3 为 `USER_INPUT`，内容是 `Model Selection from Gemini 3.8 Flash to Unknown Review Model.`。
3. 调用真实 `scanConversation(id, { force: true })`，返回：

```json
{
  "model": "Unknown Review Model",
  "modelKey": null,
  "budget": 200000,
  "budgetSource": "server",
  "percent": 50.5
}
```

**原因与影响**：模型名称和容量来自不同轮次。对新模型没有容量证据，却把上一模型的 200K 作为它的服务端阈值，继续计算精确百分比。T3 已移除硬编码默认值，但这里仍会通过旧模型数据产生相同类型的误导。

**建议**：容量必须关联到对应模型 / 轮次。当前模型已切换且没有它的新容量证据时，当前预算与百分比保持未知；可以保留上一轮 Token 统计，但明确其归属。不要为了填值猜测新模型容量。新模型 metadata 到达后再恢复当前预算。

**验收**：A → 未知 B、A → 已知但尚无容量 metadata 的 B、B 首轮返回新容量、同一模型继续请求。保证历史轮次仍保留 A 的真实容量，当前界面和 JSON 不将 A 的容量标为 B 的服务端容量。

## U3 · P2：仅含重置时间的摘要窗口遮蔽已知基础配额

**位置**：[pricing.mjs](../sidecars/dashboard/pricing.mjs) 第 388–399 行；[app.js](../sidecars/dashboard/app.js) 第 859–861、1815–1819 行；[float_window.mjs](../sidecars/dashboard/float_window.mjs) 的配额标题及 tooltip 使用相同的回退条件。

**输入**：

```js
const configs = [{
  label: 'Gemini 3.8 Flash', modelId: 'flash',
  quotaInfo: { poolId: 'flash', remainingFraction: 0.4 }
}];
const summaries = [{
  groupId: 'flash',
  buckets: [{ window: '5h', resetTime: '2026-11-13T00:00:00Z' }]
}];
```

**复现结果**：真实 `groupModelQuotas` / `resolveModelQuota` 返回顶层 `remainingPercent: 40`，且 `fiveHour.remainingPercent: null`。真实前端渲染“余量未知 · 重置时间”，费用页未显示 40%；真实 `formatStatusItemFromSnapshot(..., 'quota')` 返回 `⏳ 额度 --%`。

**原因与影响**：后端明确保留基础配额作为回退，但前端只有在 `!q.fiveHour` 时才接受顶层数值。T1 修复后 reset-only 窗口成为真实对象，导致“窗口对象存在”被当成“该窗口有可用百分比”，反而隐藏了已知的基础余量。普通请求成功且 `quotaStatus` 为 live 时也能触发。

**建议**：统一“摘要百分比已知时优先，否则仍保留已知基础配额”的解析规则。不能确认基础配额属于 5h 时，可单独标为“基础配额 40%”，同时保留“5h 余量未知 / 重置时间”；不要丢值，也不要把不确定的窗口归属强行确定化。让网页、菜单栏和 CLI 采用相同规则。

**验收**：基础配额分别为 40% / 0%、摘要只有 reset；摘要有明确百分比时正确优先；基础与摘要都未知时继续显示未知；仅 weekly 的前轮用例仍通过。

## 验证记录与后续建议

2026-11-12 23:23（北京时间），macOS + Node.js `v24.14.1`：

- `node scripts/verify.mjs`：6 / 6 阶段通过，检查 36 个源码文件，包含此前 R1–R8、F1–F4、T1–T3 回归。
- `node scripts/package-release.mjs`：通过，20 个文件、约 138.5 KB。ZIP SHA-256 为 `934d2999bd9ca28ef5c876f92172c4f864f0c9b1e17f1ad7980fa277d05ed66e`。
- 在 `dist` 执行 `LC_ALL=C shasum -a 256 -c context-viewer-v1.6.3.zip.sha256`，以及 Python `zipfile.testzip()` / 条目数检查：通过。
- `bash -n install.sh`、`git diff --check`：通过。
- 额外临时探针复用现有渲染 harness，调用真实 pricing / collector / 菜单栏函数并启动隔离 mock LS，确认 U1–U3。未读取真实会话或改动真实插件数据。

现有测试通过不代表上述组合已覆盖。目前脚本主要分别测试“无容量 + 手动基准”与“有容量 + 自动模式”，没有覆盖两者交叉；配额用例也未覆盖“基础有值 + 摘要只有重置时间”。建议把这几组组合加入现有回归，不必另建框架。

本轮未重新执行 Windows / Linux 桌面、Node.js 18、真实宿主安装或长期性能验证。前轮的费率溯源、平台矩阵和性能测量继续保持后置建议，不扩大本次修复要求。当前应优先修 U1–U3；没有整体重写语言的必要。

业务源码未修改，文档更新后仅检查差异、内部链接及源码哈希；探针临时产物清理，复现输入与结果保留于本报告。
