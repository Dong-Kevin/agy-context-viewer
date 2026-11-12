---
name: context-viewer
description: 查看当前会话上下文窗口占用、缓存命中率、模型生成速度（TTFT / tok/s）、每轮消耗涨跌时间线、桌面端与 agy CLI 历史 Token 用量及 API 订阅折算对比，或在桌面端一键打开侧边栏可视化看板。当用户询问上下文占用、Token 消耗、配额池余量或费用估算时触发。
---

# 上下文与 Token 看板 (`context-viewer`)

本技能同时兼容 **Antigravity 桌面端 (`agy` App / IDE)** 与 **终端 `agy` CLI**，全程基于本地会话归档与官方只读接口运行，不修改客户端安装包或全局 `config.json`。

## 1. 获取精确实时统计数据（App 与 CLI 通用）

先根据当前技能文件 `SKILL.md` 所在的目录 `<skill-dir>`，运行内置跨平台脚本（自动兼容 macOS / Linux / Windows 及任意插件安装目录名）：

```bash
node "<skill-dir>/scripts/status.mjs" --json
```

如需指定会话 ID，可追加会话 ID 参数：

```bash
node "<skill-dir>/scripts/status.mjs" --json "<conversation-id>"
```

脚本返回的 JSON 中已包含：
- `entrypoints.sidecarAuxPane`：当前插件实际目录对应的 `sidecar://<dir>/dashboard/` 链接
- `entrypoints.customizationSettings`：当前插件对应的 `customization://<dir>` 设置页链接
- `conversation`：当前会话窗口水位、待发送预估 Token、缓存命中率、生成速度、四维累计吞吐与会话 API 等值金额
- `recentTurns`：最近轮次的上下文水位、`±Delta` 与工具调用列表
- `globalHistory` 与 `quotas`：桌面端 + `agy` CLI 多源累计 Token、本月折算费用与实时模型配额池余量

## 2. 按宿主环境呈现结果

### 在 Antigravity 桌面端 / IDE 中
1. 用简洁要点或表格汇报用户关心的指标（窗口水位、缓存命中率、速度、累计吞吐或费用）。
2. 若用户希望快捷打开右侧栏看板，直接输出脚本返回的 `entrypoints.sidecarAuxPane` 单行胶囊链接，例如：
   `[上下文看板](sidecar://context-viewer/dashboard/)`
   *(注意：务必使用脚本返回的实际 `<dir>` 目录名，切勿硬编码。若插件或 Sidecar 尚未开启，则引导点击 `[上下文与 Token 看板](customization://<dir>)` 启用。)*
3. **自由切换「顶部菜单栏常驻图标（3 种定制内容 + 切换会话自动跟随）」与「屏幕右侧独立置顶小窗（`📌`）」**：
   - **顶部系统菜单栏常驻图标（macOS 默认开启，切换不同或静止会话时自动跟随更新；左键秒开 / 收回右侧看板，右键快捷切换显示内容）**：
     ```bash
     node "<skill-dir>/scripts/status.mjs" menubar context   # 切换显示：当前上下文使用占比（如 ◈ 43%）
     node "<skill-dir>/scripts/status.mjs" menubar speed     # 切换显示：最新生成速度与耗时（如 ⚡ 35t/s·49s (均38/峰132)）
     node "<skill-dir>/scripts/status.mjs" menubar quota     # 切换显示：5 小时 / Week 额度余量（如 ⏳ 5h 95%·1h08m）
     node "<skill-dir>/scripts/status.mjs" menubar on        # 开启顶部菜单栏常驻图标
     node "<skill-dir>/scripts/status.mjs" menubar off       # 关闭顶部菜单栏常驻图标
     ```
     也可直接**右键点击 macOS 顶部菜单栏图标**勾选切换，或在看板右上角调色盘设置抽屉的「菜单栏显示内容」分段按钮中一键切换。
   - **屏幕右侧独立置顶小窗（不受右侧栏切换影响，免点 `Toggle Side Panel -> Extensions`）**：
     ```bash
     node "<skill-dir>/scripts/status.mjs" float           # 弹出并钉住右侧独立置顶小窗
     node "<skill-dir>/scripts/status.mjs" float close     # 收回独立小窗
     ```
     也可点击看板右上角的 `📌` 按钮一键切换置顶 / 取消置顶。

### 在终端 `agy` CLI 中
1. 直接汇报终端统计摘要（也可以运行不带 `--json` 的 `node "<skill-dir>/scripts/status.mjs"` 查看彩色终端进度条看板，或传 `turns` 查看逐轮消耗表）。
2. 若用户希望在屏幕右侧常驻一个独立可视化置顶小窗，可运行 `node "<skill-dir>/scripts/status.mjs" float`；若希望在浏览器标签页查看完整热力图面板，可运行：
   ```bash
   node "<skill-dir>/scripts/status.mjs" web
   ```
   该命令会在本地回环地址 `http://127.0.0.1:18970` 启动看板并自动唤起系统浏览器。
