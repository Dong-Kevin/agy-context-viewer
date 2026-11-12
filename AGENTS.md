# 项目开发与发布约束 (`agy-context-viewer`)

## 关键入口

- 插件清单：[plugin.json](./plugin.json)
- 伴随技能与跨平台脚本：[skills/context-viewer/SKILL.md](./skills/context-viewer/SKILL.md) 、`skills/context-viewer/scripts/status.mjs`
- Sidecar 后端与采集器：`sidecars/dashboard/main.mjs` 、`sidecars/dashboard/collector.mjs` 、`sidecars/dashboard/pricing.mjs` 、`sidecars/dashboard/cli.mjs`
- 菜单栏与独立小窗：`sidecars/dashboard/float_window.mjs` 、`sidecars/dashboard/native_float_macos.swift`
- 前端看板：`sidecars/dashboard/index.html` 、`sidecars/dashboard/styles.css` 、`sidecars/dashboard/app.js`
- 安装与发布脚本：`install.sh` 、`install.ps1` 、`scripts/verify.mjs` 、`scripts/package-release.mjs`

## 不可破坏的技术约束

1. **宿主合规边界**：严禁在脚本或代码中直接改写 `~/.gemini/config/config.json` 或客户端 `app.asar`；`plugin.json` 顶层仅保留官方支持字段，未知字段会被加载器静默丢弃。
2. **宿主主题 CSS 隔离**：`sidecar_sdk/preload.js` 会在 `<html style>` 上直接注入 `--muted`（浅灰底色）、`--accent`、`--border` 等行内变量。看板内部自定义属性必须保持 `--cv-*` 命名空间前缀，禁止重新使用无前缀的 `--muted`、`--accent`、`--bg`、`--surface`、`--fg`。
3. **跨平台与目录名无关性**：`SKILL.md` 与 `status.mjs` 必须通过相对路径与运行时目录名解析 `sidecar://<dir>/dashboard/`，不得硬编码个人主目录或固定安装文件夹名。
4. **零外部运行时依赖**：仅使用 Node.js `>= 18` 内置模块，不在插件或 Sidecar 中引入 `node_modules` 第三方运行时包。

## 发布前必跑检查

```bash
node scripts/verify.mjs
node scripts/package-release.mjs
```
