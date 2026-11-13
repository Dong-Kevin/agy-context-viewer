# 开源代码审查报告

审查时间：2026-11-12 16:44（北京时间）。

审查基线：[Dong-Kevin/agy-context-viewer](https://github.com/Dong-Kevin/agy-context-viewer)，`main`，`v1.6.2`，提交 `4256ee30cc72b22bda1437692c922c2574ae5177`。以下代码行号均指此提交，后续修复后可能变化。

## 结论

项目具备开源基础：有 MIT 许可证、双语 README、明确的运行时发布清单、无第三方 npm 运行时依赖，以及可执行的校验和打包脚本。不过，当前版本仍存在 **1 项 P1、7 项 P2 问题**，涉及本地 HTTP 操作权限、热力图日期、配额刷新与分组、模型识别、异常请求处理和 Windows 路径编码。建议优先修复 P1，再修复直接影响统计可信度的 R2 至 R6。

现有 `verify.mjs` 全部通过并不代表这些行为正确。它主要检查结构、语法、隐私模式、少量固定样例和接口是否返回 200，没有覆盖本报告复现的关键分支。

本次只新增审查文档、同步 ROADMAP，未修复业务代码，未执行安装、升级、卸载、提交、推送或发布。

## 方法、证据与限制

- 当前 Codex 会话完成了源码及调用链审查，并用隔离目录、合成会话和模拟语言服务执行定向验证。未读取用户真实会话，不调用真实宿主状态接口，不启动已安装的菜单栏或终端。
- 额外尝试了本机独立 `codex review` 命令。首次受沙箱内 app-server 初始化限制；经工具权限流程启动后，服务最终返回 `401 Unauthorized: Missing bearer or basic authentication in header`，审查中断。**该独立命令没有产生可用的审查结论；本文结论来自当前 Codex 会话，不能作为独立 CLI review 成功记录。** 未修改全局认证或模型配置。
- 本机验证环境为 macOS、Node.js `v24.14.1`。没有完成 Node.js 18、Windows、Linux 或 Antigravity 宿主集成实测。R8 为源码与官方编码语义确认，Windows 端到端验证仍待补充。
- R1 已验证服务端接受不可信来源请求并持久化设置；未进行真实恶意网页、DNS rebinding 或不同浏览器本地网络权限策略的端到端攻击测试，也未证明任意命令执行或数据外传。
- 检查了当前 8 张截图的可见内容，未见明显的真实邮箱、个人绝对路径或凭据；未对历史截图逐张做像素审计。对仓库两个可达提交的 47 份文本文件版本进行了有限敏感模式扫描，未命中所检查的个人路径、常见 token 或私钥头模式。该结果不是完整的秘密检测或来源权利审计。

## 问题清单

P1：建议优先修复的安全边界问题。P2：应在后续维护版本修复的功能或兼容性问题。下面的优化建议不计入缺陷数量。

| 编号 | 优先级 | 问题 | 证据类型 |
| --- | --- | --- | --- |
| R1 | P1 | 本地 HTTP 写接口缺少来源校验和授权机制 | 隔离服务请求复现 |
| R2 | P2 | 热力图起始日期被连续回退两次，当前年份消失 | 执行原日期计算代码，并与仓库截图交叉核对 |
| R3 | P2 | ETag 不包含配额，已变化的数据仍被判定为未变化 | 模拟语言服务复现 |
| R4 | P2 | 不同模型组仅凭余额与重置时间被合并 | 直接调用导出函数复现 |
| R5 | P2 | 离线会话统计忽略日志自身的模型字段 | 同一合成日志对比会话与历史统计 |
| R6 | P2 | 模型切换解析在版本号小数点处截断 | 执行原解析函数复现 |
| R7 | P2 | 非法请求 URL 能直接终止独立 HTTP 服务 | 隔离服务请求复现 |
| R8 | P2 | Windows 命令入口使用 ASCII，破坏非 ASCII 路径 | 源码与官方编码定义确认 |

### R1：为独立 HTTP 模式的写操作建立授权边界

**位置**：[main.mjs](../sidecars/dashboard/main.mjs)，第 223 至 229、232 至 251 行；相同问题出现在 [float_window.mjs](../sidecars/dashboard/float_window.mjs) 的浏览器回退 HTTP 服务，第 1337 至 1375 行。

**触发与影响**：用户运行 `agy-context web`，或使用 Windows / Linux 浏览器回退小窗时，HTTP 服务会暴露保存设置、切换入口、控制小窗、启动 CLI 终端等 POST 路由。服务仅绑定回环地址，但没有校验 `Host`、`Origin` 或请求令牌，并且不检查 `Content-Type`，直接把 `text/plain` 请求体当 JSON 处理。能向该端口发请求的非预期调用者因此也能执行写操作；“只绑定本地”不足以保证这些操作来自看板。

**已验证**：向新建的隔离服务发送 `Origin: https://review.invalid`、`Host: review.invalid`、`Content-Type: text/plain` 的 `POST /api/settings`，请求体为合成的 `uiPreferences` 标记，返回 200；随后 GET 确认标记已写入。没有调用启动终端、修改插件清单或控制真实守护进程的路由。

**判断依据**：CORS 中的简单 POST 可以使用 `text/plain`，拒绝跨域读取响应不等同于阻止请求产生副作用。浏览器还可能施加额外的本地网络访问限制，因此本报告将“服务端缺少防护”与“所有浏览器均可直接利用”区分。[MDN 的简单请求与 CSRF 说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#simple_requests) 。

**修复建议**：两个 HTTP 入口统一校验受信任的 Host；写操作校验 Origin 并使用会话级随机令牌，拒绝不符合协议的请求体类型。不要通过开放 CORS 来解决。宿主 Sidecar 与原生内存 IPC 的信任模型单独处理，避免直接套用 HTTP Origin 规则导致宿主功能损坏。

**验收**：外部 Origin、任意 Host、无效令牌、`text/plain` 写请求应被拒绝且不产生副作用；正常看板保存设置仍可成功；终端及窗口控制路由遵循同一保护。

### R2：热力图仅应从结束日期回退一次

**位置**：[app.js](../sidecars/dashboard/app.js)，第 1164 至 1166 行。

**触发与影响**：默认打开“用量趋势 → 每天”。`startSun` 先被 `setDate` 回退约一年，再以已经改变的年月执行第二次 `setDate`，因此再次回退约一年。后续只渲染 371 天，当前年份数据落在范围外；范围标签却仍以今天结尾，造成“总用量有数据，热力图为空”的矛盾。

**已验证**：使用 `todayKey = 2026-11-12`、`heatPageOffset = 0` 执行仓库原日期计算，实际单元格从 **2024-11-09 到 2025-11-14**，不包含今天；正确的 53 周日历应从 **2025-11-09 到 2026-11-14**。仓库 [usage-trends.png](images/usage-trends.png) 中“2024-11-09 至 2026-11-12”、空热力图与非零总量也与此一致。

**修复建议**：从 `endSat` 的副本仅回退 `53 * 7 - 1` 天，移除前一条重复回退语句。

**验收**：371 个日期连续、首日周日、末日周六，今天在范围内；加入跨年、闰年及翻页样例，确认今日有记录时格子和区间汇总均非零。

### R3：配额变化必须使响应版本变化

**位置**：[collector.mjs](../sidecars/dashboard/collector.mjs)，第 1414、1821 行；[main.mjs](../sidecars/dashboard/main.mjs)，第 48 至 74 行；[app.js](../sidecars/dashboard/app.js)，第 386 至 408 行。

**触发与影响**：会话日志没有新增内容，但账号在其他会话消耗额度、额度重置，或宿主补充了元数据。采集器虽然刷新了 `quotas` / `modelQuotas`，两个 ETag 却都不包含配额。HTTP / IPC 处理器返回 `unchanged: true`，前端提前退出，旧配额会持续显示，直到日志改变或用户强制刷新。不是仅等待 30 秒缓存过期即可恢复。

**已验证**：模拟 `GetUserStatus` 的余额从 90% 改为 20%，分别强制重新采集两次，确认返回配额确实变化，但 `scanConversation` 与 `collectTokenHistory` 各自的 ETag 均相同。普通带旧 ETag 的轮询由上述处理器直接判定为未变化。

**修复建议**：对会影响展示的稳定业务字段计算内容版本，或拆分会话、配额和设置的版本；不要直接加入每次变化的 `scannedAt`，否则会使缓存失去意义。历史视图还应考虑来源、模型归属及价格分项变化。

**验收**：日志不变，仅修改配额百分比或重置时间，下一次采集刷新后普通轮询应得到新数据；真正未变化时仍返回 `unchanged`。

### R4：不要把相同余额当作同一个配额池的标识

**位置**：[pricing.mjs](../sidecars/dashboard/pricing.mjs)，第 225 至 230、246 至 250 行。

**触发与影响**：两个独立模型组恰好有相同 `quotaInfo.remainingFraction` 和 `resetTime`，或这两个字段都缺失。当前分组键只由这两个值组成，Gemini 与 Claude / GPT 会被合并。合并后用整个模型列表匹配第一个 summary group，导致其他组的 5h / Week 余额被替换。

**已验证**：输入 Gemini 与 Claude 两项相同旧余额和重置时间，同时提供 Gemini 80%、Claude 20% 的两个 summary group，函数只返回 **一个 80% 的混合池**。

**修复建议**：优先按 summary group / bucket 的稳定身份分组，再关联模型；没有明确池 ID 时采用保守的模型组隔离规则，不能仅凭数值相同推断共享关系。

**验收**：不同组即使同时 100% 或字段缺失，也不能合并；同一组的 High / Low 档位仍可合并；改变 summary group 顺序不能改变模型所属额度。

### R5：离线会话统计应优先读取日志里的模型字段

**位置**：[collector.mjs](../sidecars/dashboard/collector.mjs)，第 1215 至 1221、1241 至 1245 行；对照历史采集第 1649 行附近的 `rawModel` 取值。

**触发与影响**：语言服务 generator metadata 不可用，日志 `PLANNER_RESPONSE` 自带 `model`，但没有“Model Selection”文字。会话统计仅使用 `runningModel`，忽略该行的 `model`；全局历史统计却读取 `ev.model`。同一份数据因此出现历史费用非零、当前会话未识别模型且费用为零的矛盾，也会影响当前模型的配额关联。

**已验证**：合成一条 `model: "Gemini 4 Carbon"`、输入 1000 / 输出 100 的响应。当前会话返回 `modelKey: null`、`isPriced: false`；同一日志的历史汇总识别到模型并产生非零参考费用。

**修复建议**：会话与历史共用明确的模型字段优先级；优先采用每次响应记录的模型信息，再使用会话中的模型切换提示。

**验收**：不连接语言服务、无切换提示时，两种视图仍识别相同模型与费用；有模型切换时按每轮实际模型计费。

### R6：模型版本号中的小数点不是文本结束符

**位置**：[collector.mjs](../sidecars/dashboard/collector.mjs)，第 692 至 697 行。

**触发与影响**：模型切换描述含 `Gemini 3.8 Flash`、`Gemini 3.1 Pro` 等名称。正则 `([^\n.]+?)` 把小数点当终止符，模型变成 `Gemini 3`，随后的规范化与计费失败。此解析同时被会话和历史采集使用。

**已验证**：执行原函数，输入 `Model Selection from Gemini 4 Carbon to Gemini 3.8 Flash.`，输出为 **`Gemini 3`**。

**修复建议**：优先使用结构化字段；必须解析文本时允许模型名称中的版本小数点，只剥离真正的句末标点或明确的元数据边界。

**验收**：覆盖 `3.8`、`3.1`、`5.5`、无小数版本、括号档位和多次切换，最后一次模型名称应完整保留。

### R7：URL 解析错误应返回 400，不能退出服务

**位置**：[main.mjs](../sidecars/dashboard/main.mjs)，第 232 至 234 行；类似入口在 [float_window.mjs](../sidecars/dashboard/float_window.mjs)，第 1337 至 1338 行。

**触发与影响**：收到请求目标 `//[`。HTTP 解析器接受请求后，`new URL(req.url, base)` 抛出 `ERR_INVALID_URL`，但该代码位于后续 `try/catch` 外，未捕获异常终止整个 Node.js 服务。

**已验证**：用 `node:http.request` 向隔离 standalone 服务发送该路径，进程以退出码 1 结束。浏览器回退入口具有相同源码模式，但未单独启动回退窗口复测。

**修复建议**：在统一请求入口捕获 URL 解析异常，校验请求目标形式并返回 400；两个 HTTP 入口都处理此边界。

**验收**：发出畸形路径后，正常 `GET /` 与 `/api/settings` 仍可响应，进程保持存活。

### R8：Windows 命令入口不能用 ASCII 序列化用户路径

**位置**：[install.ps1](../install.ps1)，第 100 至 101 行。

**触发与影响**：Windows 用户目录或自定义插件目录包含中文等非 ASCII 字符。脚本把包含 `$TargetDir` 的整条命令用 `Set-Content -Encoding ASCII` 写入 `.cmd`，路径字符不能被保留，安装显示成功后 `agy-context` 找不到实际脚本。

**证据等级**：源码及官方语义确认；未在 Windows 上执行安装器。微软明确说明 `ascii` 为 7-bit 字符集。[Set-Content 编码说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content#-encoding) 。

**修复建议**：采用能保留 Unicode 路径且与目标 PowerShell / cmd 环境一致的入口方案；不要仅把编码改成 UTF-8 就假定所有 Windows 代码页均兼容。尽量避免把用户绝对路径直接嵌入受代码页影响的脚本。

**验收**：Windows PowerShell 5.1 与 PowerShell 7，分别在中文、空格、纯英文路径下安装并运行 `agy-context --help`、`json`。这些是后续修复验收建议，本次没有执行。

## 开源发布与维护优化建议

以下是建议，尚未获得实施授权，也未作为本次审查完成的额外条件。

1. **补齐安装前置条件与能力矩阵。** README 当前只列 Node.js，但 macOS 原生菜单栏还依赖可用的 Swift 编译工具链，见 `float_window.mjs:900-933`。编译失败且启动隐藏菜单栏时进程会直接退出，安装器又吞掉错误。建议说明 Command Line Tools 要求并保留可读错误。Windows / Linux 回退模式固定 `pinned: false`，使用浏览器 app 窗口，没有实现 macOS 的原生置顶能力，应明确区别。终端模式缺少宿主注入的语言服务地址和凭据时，自动订阅 / 配额功能也会退化。
2. **让隐私说明覆盖字体网络请求。** `index.html:9-11` 加载 Google Fonts；只有 macOS 内存 HTML 打包函数显式移除这些链接。未发现它们发送对话内容，但“所有运行界面完全离线”不能据此成立。建议使用已有系统字体，或明确披露字体请求，并区分本地采集与外部静态资源加载。现有 README 所说“不发送对话正文”不因字体请求自动被判定为虚假。
3. **收窄安装升级与卸载的承诺。** `install.sh:126-131` 逐个覆盖运行时文件，仅最后的 `sidecar.json` 使用重命名替换，整个升级并非事务式原子操作；PowerShell 也逐文件覆盖。建议暂存并校验完整新版本，明确失败状态，补一次升级中断场景。README 的“卸载不留残余”与 Shell 卸载刻意保留统计偏好不一致，应说明保留项，而不是默认删除用户数据。
4. **给价格、汇率和模型映射补证据。** `pricing.mjs` 有核验日期、未来生效规则及费率，但没有逐项来源链接。`normalizeModelId` 还把所有包含 Claude Opus / Sonnet、或泛称 Flash 的名称映射为固定版本，旧模型可能被标成新模型。建议精确匹配已知版本，为未知模型保留“未定价”；记录费率来源与适用日期。本文未独立核验这些模型费率、订阅价格和汇率，不能据本文背书其准确性。
5. **把有限模式扫描与安全审计区分。** `verify.mjs` 只检查少数 token 格式、路径及 PNG 元数据，不检查截图像素、所有凭据种类或完整 Git 历史。建议修改“严格隐私审计”等过强表述，补人工截图检查与发布前定向秘密扫描。现有 MIT 文件和致谢均存在；仅凭致谢无法确认所有素材和实现的来源权利，也没有证据认定侵权。
6. **用行为回归补强现有验证。** 优先覆盖本报告的日期、ETag、分池、模型名、HTTP 边界与非 ASCII 路径；保留无宿主环境的合成 fixtures。不要只增加“源码中不含某字符串”的断言。当前 HTTP 冒烟仅检查 200，也没有对安装器、Swift 编译或最低 Node.js 版本做验收。没有必要为了这些小规模检查新增第三方运行时依赖或 GitHub Actions。
7. **提高发布版本的可追溯性。** 在线安装器默认下载可变的 `main`，而 Release ZIP 有独立 SHA-256。建议文档提供固定 tag 安装方式，说明脚本版本与归档版本的对应关系；保留校验步骤。现有下载链使用 HTTPS，不能仅因从 main 安装就判定为已被攻击。运行时 ZIP 刻意排除了截图，但仍打包引用截图的 README，离线阅读会有断图，可指向在线截图画廊。
8. **补最小维护入口。** 可增加简短贡献说明和安全问题报告渠道；说明支持的宿主版本、哪些接口来自宿主注入，以及如何在无真实会话的环境运行检查。README 中 `<5ms`、约 `1.5s` 等性能承诺尚缺可复现测量环境与样本，建议补证据或改为定性描述。

## 本次验证记录

| 检查 | 结果 | 范围说明 |
| --- | --- | --- |
| `node scripts/verify.mjs` | 通过 | 初始 33 个文件；文档写入后于 16:48 再次通过，共 34 个文件；使用隔离数据目录，无真实宿主连接 |
| `node scripts/package-release.mjs` | 通过 | 20 个文件，约 127.5 KB；仅本地生成，未发布 |
| ZIP CRC、SHA-256、许可证与安装脚本执行位 | 通过 | 使用 Python 标准库独立检查生成归档 |
| `bash -n install.sh` | 通过 | 仅 Shell 语法，不代表安装 / 升级运行通过 |
| 合成会话与模拟语言服务探针 | 复现 R3、R4、R5 | 具体输入与返回值见对应条目 |
| 原日期 / 模型解析函数探针 | 复现 R2、R6 | 执行从仓库读取的对应代码片段 |
| 隔离 HTTP 请求探针 | 复现 R1、R7 | 只写临时设置；仅终止本次测试服务 |
| 两个可达提交的有限文本敏感模式扫描 | 未命中 | 47 份文本版本；跳过验证器自身和图片 |
| 当前 8 张 PNG 可见内容检查 | 未见明显敏感内容 | 不是来源鉴定或全部历史像素审计 |
| 独立 `codex review` | 未完成 | HTTP 401 认证失败，无独立结论 |
| 文档链接、内嵌复现样例与 `git diff --check` | 通过 | 16:48 核对，8 个问题条目齐全，文档中的纯计算命令实际运行通过 |

原始探针输出摘要：

```text
ETAG: quota 90 -> 20; context/history ETags both unchanged
MODEL: transcript model recognized in history, absent and unpriced in context
QUOTA_GROUP: Gemini 80% and Claude 20% merged into one 80% pool
HTTP: foreign Origin + Host + text/plain POST persisted settings (200)
HTTP_URL: GET //[ terminated server with exit 1
HEATMAP: today=2026-11-12, first=2024-11-09, last=2025-11-14, includesToday=false
MODEL_SETTING: Gemini 3.8 Flash -> Gemini 3
```

## 可复现的最小样例

在仓库根目录运行以下纯计算样例，不会访问用户数据。它验证当前错误行为，修复后应改为断言预期正确行为。

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { groupModelQuotas } from './sidecars/dashboard/pricing.mjs';

const app = readFileSync('sidecars/dashboard/app.js', 'utf8');
const start = app.indexOf('    const endSat = new Date(endAnchor);');
const end = app.indexOf('\n\n    const firstDate', start);
const dates = runInNewContext(app.slice(start, end) + `;
  const last = new Date(startSun); last.setDate(last.getDate() + 370);
  [startSun, last].map(d => [d.getFullYear(), d.getMonth() + 1, d.getDate()]);
`, { endAnchor: new Date(2026, 10, 12) });
console.log('heatmap actual:', dates);
assert.equal(JSON.stringify(dates), '[[2024,11,9],[2025,11,14]]');

const collector = readFileSync('sidecars/dashboard/collector.mjs', 'utf8');
const fn = collector.match(/function parseModelSettingFromText\(text\) \{[\s\S]*?\n\}/)[0];
const parsed = runInNewContext(fn + `;
  parseModelSettingFromText('Model Selection from Gemini 4 Carbon to Gemini 3.8 Flash.');
`);
assert.equal(parsed, 'Gemini 3');
console.log('parsed model:', parsed);

const quotaInfo = { remainingFraction: 1, resetTime: '2026-11-13T10:00:00Z' };
const pools = groupModelQuotas([
  { label: 'Gemini 4 Carbon', quotaInfo },
  { label: 'Claude Opus 5.5', quotaInfo }
], [
  { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
  { displayName: 'Claude Models', buckets: [{ window: '5h', remainingFraction: 0.2 }] }
]);
assert.equal(pools.length, 1);
assert.equal(pools[0].remainingPercent, 80);
console.log('merged pools:', pools.length, pools[0].remainingPercent);
JS
```

HTTP 与采集器复现应使用 `AG_DIR`、`AG_CLI_DIR`、`ANTIGRAVITY_EXECUTABLE_DATA_DIR` 指向任务专属临时目录，并清空真实语言服务环境变量，或将其指向模拟服务。R1 的请求方法、头、路径和持久化观察点，R3 / R5 的合成输入，以及 R7 的请求路径均已在对应条目记录；不要对已安装的真实服务运行写入探针。

## 后续处理建议

先处理 R1 的两个 HTTP 入口，再处理 R2 至 R6 的统计正确性，随后补 R7 / R8 的异常与兼容性验证。每项修复以对应行为验收为准。本次授权仅覆盖拉取、审查、验证和记录文档；修复、提交、推送、发布均未执行。
