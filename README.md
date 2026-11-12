<img src="assets/logo.svg" width="84" align="right" alt="Antigravity Context & Token Viewer Logo" />

# Antigravity Context & Token Viewer (`agy-context-viewer`)

[![Version](https://img.shields.io/badge/version-v1.6.1-38bdf8)](https://github.com/Dong-Kevin/agy-context-viewer/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-818cf8)](#一键安装)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-22c55e)](#一键安装)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-a855f7)](#隐私与安全说明)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](./LICENSE)

面向 **Google Antigravity 桌面端（`agy` App / IDE）** 与 **终端 `agy` CLI** 的官方规范上下文窗口、生成速度、配额余量与 Token 历史看板插件。

> **English Summary**: Official-spec real-time Context Window, Generation Speed (`TTFT` / `tok/s`), Model Quota & Token Usage Analytics plugin for **Google Antigravity IDE** and **`agy` CLI**. Features a customizable **macOS Menu Bar live indicator** (switchable between Context %, Speed & Duration, and `5h / Week` Quota with automatic conversation-switch follow), a **right-side pinned floating window (`📌`)**, Aux Pane sidecar integration, CLI ANSI dashboard, and standalone Web UI — 100% read-only local data collection with **zero external dependencies** and **zero client binary patching**.

---

## 核心特性

- **macOS 顶部系统菜单栏常驻看板（3 档显示定制 + 切换会话自动跟随）**
  - 支持在 **3 种实时指标**之间一键切换：
    1. **当前上下文使用占比**（默认）：`◈ 43%`（高水位自动预警 `⚠ 92%`）
    2. **最新生成速度与耗时（含均值 / 峰值）**：`⚡ 35t/s·49s (均38/峰132)`
    3. **5 小时 / Week 配额余量与重置倒计时**：`⏳ 5h 95%·1h08m` / `⏳ Week 82%·4d6h`
  - **切换对话自动跟随**：在左侧栏点击切换不同对话（包含未发新消息的静止历史对话）时，顶部菜单栏与悬浮小窗在约 `1.5s` 内自动同步到当前浏览会话；也可在面板下拉框手动锁定指定会话。
  - **四段式精简悬停卡片 & `<5ms` 秒开交互**：鼠标悬停展示分组清晰的「会话与模型 / 水位与速度 / 分池配额重置 / 快捷操作」概览；**左键单击**秒开或收回右侧小窗，**右键单击**弹出原生菜单切换显示模式与置顶状态。
- **屏幕右侧独立置顶小窗（`📌`，免点 `Toggle Side Panel -> Extensions`）**
  - 一键将看板钉在屏幕右侧最前，即使宿主右侧栏切到 Artifacts、Diff 或终端也常驻可见；随时可通过标题栏按钮、窗口内 `📌` 或快捷键 `Cmd+Shift+P` 切换置顶，按 `Cmd+W` 收回。
- **桌面端 App 与终端 `agy` CLI 双端原生体验**
  - 桌面端同时提供 **顶部菜单栏**、**右侧独立置顶小窗** 与 **宿主右侧内嵌辅助栏（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）** 三种入口；
  - 终端与 `agy` CLI 提供 `/context-viewer` 对话技能、`agy-context` 彩色进度条看板、`agy-context turns` 逐轮涨跌表、`agy-context json` 脚本输出与 `agy-context web` 浏览器完整热力图面板。
- **零侵入、安全合规、零第三方依赖**
  - 严格遵循官方 `plugin.json` 与 `sidecar_sdk` 规范，**不修改客户端 `app.asar` 安装包、不注入 CDP 渲染进程、不直接改写 `~/.gemini/config/config.json`**，完整保留客户端签名与自动更新能力。
  - 纯 Node.js（`>= 18`）标准库与原生 Web / Cocoa 组件构建，零 `node_modules` 运行时依赖，跨 **macOS / Linux / Windows** 开箱即用。

---

## 一键安装

> **前置要求**：本机已安装 `Node.js >= 18`。重复运行安装命令即可平滑热升级到最新版本。

### 方式 1：macOS / Linux 一键脚本安装（推荐）

自动安装插件、启用 macOS 顶部菜单栏常驻图标，并注册终端 `agy-context` 快捷命令：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dong-Kevin/agy-context-viewer/main/install.sh)"
```

### 方式 2：Windows PowerShell 一键安装

```powershell
irm https://raw.githubusercontent.com/Dong-Kevin/agy-context-viewer/main/install.ps1 | iex
```

### 方式 3：使用官方 `agy` CLI 安装

```bash
agy plugin install https://github.com/Dong-Kevin/agy-context-viewer
```

### 方式 4：克隆仓库或下载 Release 离线包安装

```bash
git clone https://github.com/Dong-Kevin/agy-context-viewer.git
cd agy-context-viewer
./install.sh          # Windows PowerShell 执行：.\install.ps1
```

也可前往 [Releases](https://github.com/Dong-Kevin/agy-context-viewer/releases) 下载 `context-viewer-v1.6.1.zip` 解压后执行 `./context-viewer/install.sh`（或 `agy plugin install ./context-viewer`）。

---

## 快速上手

### 1. 在 Antigravity 桌面端 / IDE 中使用

1. **顶部系统菜单栏常驻图标（macOS 默认开启）**
   - **左键单击**屏幕右上角图标：在 `<5ms` 内弹出或收回右侧看板小窗；
   - **右键单击**菜单栏图标：直接勾选切换 **上下文占比 / 最新速度与耗时 / 5h 或 Week 额度**，或切换小窗置顶、关闭菜单栏图标；
   - 也可在看板右上角调色盘设置抽屉中切换「菜单栏显示内容」，或在终端执行 `agy-context menubar [context|speed|quota|on|off]`。
2. **屏幕右侧独立置顶小窗（`📌`）**
   - 点击看板右上角 **`📌` 按钮** 或在终端执行 `agy-context float`，即可将看板独立钉在屏幕右侧；
   - 点击窗口标题栏 `📌 已置顶`（或按 `Cmd+Shift+P`）可取消置顶变为普通窗口；按 `Cmd+W`、再次点击菜单栏图标或运行 `agy-context float close` 即可收回。
3. **宿主右侧辅助栏内嵌模式**
   - 在 **Customizations → Plugins** 中确认开启「上下文与 Token 看板」，点击右侧辅助栏图标（或点击对话中的 `sidecar://context-viewer/dashboard/` 胶囊链接）即可分屏查看。
4. **主题与热力图色阶定制**
   - 点击右上角 `◐` 按钮切换 **跟随宿主主题 / 固定浅色 / 固定深色**；点击调色盘图标切换 5 套热力图预设色阶或逐档自定义取色。

### 2. 在终端与 `agy` CLI 中使用

- **对话内直接调用**：在 `agy` 会话中输入 `/context-viewer`，或直接提问「查看当前会话上下文占用、缓存命中率与 API 折算费用」。
- **终端 `agy-context` 命令速查**：

```bash
agy-context                  # 终端彩色进度条汇总（当前窗口水位、速度、近 5 轮涨跌、配额池余量）
agy-context menubar context  # 菜单栏显示：当前上下文使用占比（◈ 43%）
agy-context menubar speed    # 菜单栏显示：最新生成速度与耗时（⚡ 35t/s·49s (均38/峰132)）
agy-context menubar quota    # 菜单栏显示：5 小时 / Week 额度余量（⏳ 5h 95%·1h08m）
agy-context menubar off      # 关闭顶部菜单栏常驻图标（传 on 重新开启，传 status 查看状态）
agy-context float            # 弹出 / 切换屏幕右侧独立置顶小窗（传 close 收回，传 quit 彻底退出守护进程）
agy-context turns            # 查看最近 20 轮上下文涨跌（±Delta）与工具调用时间线
agy-context json             # 输出结构化 JSON 摘要（加 --full 输出完整原始载荷，便于脚本集成）
agy-context web              # 在 127.0.0.1:18970 启动独立 Web 服务并自动在浏览器打开完整交互看板
```

> 若仅通过 `agy plugin install` 安装而未执行 `install.sh`，可直接运行：`node ~/.gemini/config/plugins/context-viewer/sidecars/dashboard/cli.mjs`（若目录名为 `agy-context-viewer` 则替换为对应目录名）。

---

## 核心视图与统计维度

| 视图模块 | 覆盖指标与交互能力 |
| :--- | :--- |
| **当前会话** | 窗口占用圆环、实时待发送 Token 增量预估、预算上限快切（`自动 / 200K / 256K / 1M`）、缓存读取命中率、服务端三段构成条（`System Prompt / Tools / Chat Messages`，支持展开工具 Schema 明细）、四维累计吞吐（缓存读取 / 新增输入 / 输出含思考 / 总吞吐）、均值与流式峰值 `tok/s`、`TTFT`、**近 40 轮消耗涨跌 `±Delta` 与工具标签时间线**、模型配额池重置倒计时及多媒体 / 文档附件只读审计。 |
| **用量趋势** | 支持 **全部来源 / 桌面端 / CLI** 筛选；汇总累计、今日、本月、本年 4 组核心卡片；提供 **每天（53 周日历热力图） / 每周 / 每月 / 今年（12 月气泡矩阵） / 累计曲线** 5 种交互视图及日均 / 活跃日均统计。 |
| **费用与订阅** | 自动识别订阅套餐档位（账号邮箱自动脱敏）、Prompt / Flow Credits 与配额池；内置 22 个国家或地区订阅参考价、10 种获取渠道与 40+ 币种换算；支持 **本期自然月 / 全量历史** 与 **混合精确折算 / 仅已识别模型 / Flash 基准** 对比及分模型消耗排行。 |

---

## 目录结构

```text
agy-context-viewer/
├── plugin.json                        # 官方插件清单
├── install.sh                         # macOS / Linux 一键安装、热升级与卸载脚本
├── install.ps1                        # Windows PowerShell 一键安装与卸载脚本
├── assets/
│   └── logo.svg                       # 插件图标
├── skills/
│   └── context-viewer/
│       ├── SKILL.md                   # /context-viewer 跨端技能说明
│       └── scripts/status.mjs         # 目录名无关的便携 CLI 入口
├── sidecars/
│   └── dashboard/
│       ├── sidecar.json               # 官方 Aux Pane UI Sidecar 配置
│       ├── main.mjs                   # Sidecar 与独立本地 HTTP 服务入口
│       ├── collector.mjs              # 本地会话归档、活跃对话跟随与配额只读采集器
│       ├── pricing.mjs                # 模型窗口上限、API 定价与多币种订阅参考库
│       ├── float_window.mjs           # 悬浮小窗与 macOS 顶部菜单栏守护进程控制器
│       ├── native_float_macos.swift   # macOS 原生 NSStatusItem + WKWebView 零端口桥接实现
│       ├── cli.mjs                    # agy-context 终端彩色看板与控制命令
│       ├── index.html                 # 看板前端结构
│       ├── styles.css                 # --cv-* 命名空间隔离样式（适配宿主亮暗主题）
│       └── app.js                     # 看板前端渲染与交互逻辑
└── scripts/
    ├── verify.mjs                     # 清单规范、语法、隐私审计、CSS 隔离与冒烟测试套件
    └── package-release.mjs            # 零依赖跨平台 Release ZIP 与 SHA-256 打包脚本
```

---

## 隐私与安全说明

- **100% 本地只读采集**：插件仅读取本机 `~/.gemini/antigravity/brain/`、`~/.gemini/antigravity-cli/brain/`、`~/.gemini/antigravity/annotations/` 会话归档与本机回环只读元数据接口，**绝不向任何外部服务器上传对话内容、账号信息或统计数据**。
- **账号信息默认脱敏**：界面展示的登录邮箱自动脱敏处理；独立 HTTP 模式仅监听本机回环地址 `127.0.0.1`。
- **不触碰宿主核心配置**：插件自定义设置独立存放在 `~/.gemini/antigravity/sidecar_data/context-viewer/dashboard/data/settings_v1.json`，不读写 `~/.gemini/config/config.json`。

---

## 更新与卸载

- **平滑更新**：重新运行上方任一安装命令（如 `./install.sh` 或在线一键安装命令）即可原地平滑更新。
- **卸载插件**：
  - 安装脚本卸载：macOS / Linux 执行 `./install.sh --uninstall`（或远程脚本末尾追加 `-s -- --uninstall`）；Windows 执行 `.\install.ps1 -Uninstall`
  - `agy` CLI 卸载：`agy plugin uninstall context-viewer`
  - 桌面端卸载：在 `customization://context-viewer` 页面点击 **Uninstall**

---

## 本地开发与发布校验

```bash
node scripts/verify.mjs           # 运行清单规范、JS 语法、隐私脱敏、CSS 命名空间隔离与服务冒烟测试
node scripts/package-release.mjs  # 生成 dist/context-viewer-v1.6.1.zip 与 .sha256 校验文件
```

---

## License

基于 [MIT License](./LICENSE) 开源。
