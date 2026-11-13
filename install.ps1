<#
.SYNOPSIS
  One-click Installer / Updater / Uninstaller for Antigravity Context & Token Viewer (Windows PowerShell)
  Compatible with both Antigravity Desktop App (agy App / IDE) and agy CLI.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  irm https://raw.githubusercontent.com/Dong-Kevin/agy-context-viewer/main/install.ps1 | iex
.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$PluginDirName = "context-viewer"
$PluginsRoot = if ($env:ANTIGRAVITY_PLUGINS_DIR) { $env:ANTIGRAVITY_PLUGINS_DIR } else { Join-Path $HOME ".gemini\config\plugins" }
$TargetDir = Join-Path $PluginsRoot $PluginDirName
$BinDir = if ($env:ANTIGRAVITY_BIN_DIR) { $env:ANTIGRAVITY_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$CliWrapper = Join-Path $BinDir "agy-context.cmd"
$CliLoader = Join-Path $BinDir "agy-context-loader.mjs"
$RepoSlug = if ($env:REPO) { $env:REPO } else { "Dong-Kevin/agy-context-viewer" }
$GitRef = if ($env:REF) { $env:REF } else { "main" }

if ($Uninstall) {
  $ExistingCli = Join-Path $TargetDir "sidecars\dashboard\cli.mjs"
  if ((Test-Path $ExistingCli) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try { & node $ExistingCli float quit 2>&1 | Out-Null } catch {}
  }
  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[context-viewer] 已移除插件目录：$TargetDir" -ForegroundColor Green
  } else {
    Write-Host "[context-viewer] 未检测到已安装目录：$TargetDir" -ForegroundColor Cyan
  }
  if (Test-Path $CliWrapper) {
    Remove-Item -Force $CliWrapper
    Write-Host "[context-viewer] 已移除命令行入口：$CliWrapper" -ForegroundColor Green
  }
  if (Test-Path $CliLoader) {
    Remove-Item -Force $CliLoader
  }
  Write-Host "[context-viewer] 用户本地会话归档与统计偏好设置已安全保留，未做删除。" -ForegroundColor Cyan
  exit 0
}

# 1. Check Node.js >= 18
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未检测到 Node.js，请先安装 Node.js 18 或更高版本。"
}
$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 18) {
  throw "当前 Node.js 主版本为 $NodeMajor，需要 Node.js >= 18。"
}

# 2. Locate local checkout or download zip from GitHub
$SourceDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugin.json"))) {
  $SourceDir = $PSScriptRoot
}

$TempDir = $null
try {
  if (-not $SourceDir) {
    if (-not $RepoSlug) {
      throw "远程安装请先设置 `$env:REPO='Dong-Kevin/agy-context-viewer' 后再执行脚本。"
    }
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ag-cv-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ZipFile = Join-Path $TempDir "repo.zip"
    $ZipUrl = "https://codeload.github.com/$RepoSlug/zip/$GitRef"
    Write-Host "[context-viewer] 正在从 GitHub 下载 $RepoSlug ($GitRef)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath $TempDir -Force
    $FoundManifest = Get-ChildItem -Path $TempDir -Filter "plugin.json" -Recurse | Select-Object -First 1
    if (-not $FoundManifest) {
      throw "下载归档中未找到 plugin.json。"
    }
    $SourceDir = $FoundManifest.Directory.FullName
  }

  # 3. Validate & stage all required runtime files in system temp before touching $TargetDir
  $RequiredDashFiles = @(
    "package.json", "pricing.mjs", "collector.mjs", "float_window.mjs",
    "native_float_macos.swift", "cli.mjs", "index.html", "styles.css",
    "app.js", "main.mjs", "sidecar.json"
  )
  foreach ($ReqRel in @("plugin.json", "assets\logo.svg", "skills\context-viewer\SKILL.md", "skills\context-viewer\scripts\status.mjs")) {
    if (-not (Test-Path (Join-Path $SourceDir $ReqRel))) {
      throw "安装包缺少必需文件：$ReqRel"
    }
  }
  foreach ($DashFile in $RequiredDashFiles) {
    if (-not (Test-Path (Join-Path $SourceDir "sidecars\dashboard\$DashFile"))) {
      throw "安装包缺少必需文件：sidecars\dashboard\$DashFile"
    }
  }

  $ExistingCli = Join-Path $TargetDir "sidecars\dashboard\cli.mjs"
  if (Test-Path $ExistingCli) {
    try { & node $ExistingCli float quit 2>&1 | Out-Null } catch {}
  }

  New-Item -ItemType Directory -Path $PluginsRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $TargetDir "sidecars\dashboard") -Force | Out-Null

  Copy-Item (Join-Path $SourceDir "plugin.json") (Join-Path $TargetDir "plugin.json") -Force
  foreach ($OptFile in @("README.md", "LICENSE")) {
    $OptPath = Join-Path $SourceDir $OptFile
    if (Test-Path $OptPath) { Copy-Item $OptPath (Join-Path $TargetDir $OptFile) -Force }
  }
  $AssetsTarget = Join-Path $TargetDir "assets"
  $SkillsTarget = Join-Path $TargetDir "skills"
  if (Test-Path $AssetsTarget) { Remove-Item -Recurse -Force $AssetsTarget }
  if (Test-Path $SkillsTarget) { Remove-Item -Recurse -Force $SkillsTarget }
  Copy-Item (Join-Path $SourceDir "assets") $AssetsTarget -Recurse -Force
  Copy-Item (Join-Path $SourceDir "skills") $SkillsTarget -Recurse -Force

  foreach ($DashFile in @("package.json", "pricing.mjs", "collector.mjs", "float_window.mjs", "native_float_macos.swift", "cli.mjs", "index.html", "styles.css", "app.js", "main.mjs")) {
    Copy-Item (Join-Path $SourceDir "sidecars\dashboard\$DashFile") (Join-Path $TargetDir "sidecars\dashboard\$DashFile") -Force
  }
  $SidecarTmp = Join-Path $TargetDir "sidecars\dashboard\.sidecar.json.tmp"
  Copy-Item (Join-Path $SourceDir "sidecars\dashboard\sidecar.json") $SidecarTmp -Force
  Move-Item -Path $SidecarTmp -Destination (Join-Path $TargetDir "sidecars\dashboard\sidecar.json") -Force
  try { & node (Join-Path $TargetDir "sidecars\dashboard\cli.mjs") --sync-manifest 2>&1 | Out-Null } catch {}

  # 4. Create codepage-independent Unicode-safe `agy-context.cmd` + `agy-context-loader.mjs`
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $CliEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "sidecars\dashboard\cli.mjs"))
  $CliEntryB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CliEntry))
  $LoaderContent = @(
    "import { pathToFileURL } from 'node:url';",
    "const entry = Buffer.from('$CliEntryB64', 'base64').toString('utf8');",
    "process.argv[1] = entry;",
    "await import(pathToFileURL(entry).href);"
  ) -join "`n"
  $CmdContent = "@echo off`r`nnode `"%~dp0agy-context-loader.mjs`" %*`r`n"
  [System.IO.File]::WriteAllText($CliLoader, "$LoaderContent`n", [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($CliWrapper, $CmdContent, [System.Text.Encoding]::ASCII)

  # 5. Enable via agy CLI if available
  if (Get-Command agy -ErrorAction SilentlyContinue) {
    try { & agy plugin enable $PluginDirName 2>&1 | Out-Null } catch {}
  }

  $Ver = (Get-Content (Join-Path $TargetDir "plugin.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  Write-Host ""
  Write-Host "[context-viewer] 安装完成！版本：$Ver" -ForegroundColor Green
  Write-Host "  • Antigravity 桌面端：在 Customizations -> Plugins 中开启「上下文与 Token 看板」，随后从右侧栏打开看板。"
  Write-Host "  • agy CLI / 终端：在对话中输入 /context-viewer，或在终端运行 `"$CliWrapper`"（加 web 参数可在浏览器打开完整看板）。"
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
