# 下载并部署项目内 Node 运行时到 .toolchain\node\。
#
# 只需运行一次。之后 dev.ps1 / build.ps1 都直接用 .toolchain\node，
# 不再依赖系统 Node。
#
# 用法:
#   .\scripts\bootstrap.ps1
#   .\scripts\bootstrap.ps1 -Force
#   $env:CHENG_RSS_NODE_VERSION='v24.14.0'; .\scripts\bootstrap.ps1

param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/toolchain.ps1')

Initialize-Tmp
New-Item -ItemType Directory -Force -Path $ToolchainDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot '.cache/npm') | Out-Null

Write-Host ""
Write-Host "引导项目内 Node 运行时" -ForegroundColor Cyan
Write-Info "版本   $NodeVersion"
Write-Info "平台   $Platform"
Write-Info "目标   $NodeDir"

if ((Test-NodeReady) -and (-not $Force)) {
  Write-Ok "已就绪（$(Get-NodeVersionOf)），跳过下载"
  Write-Host ""
  Write-Host "下一步: .\scripts\dev.ps1"
  exit 0
}

if (Test-Path $NodeDir) {
  Write-Warn2 "移除旧的 .toolchain\node"
  Remove-Item -Recurse -Force $NodeDir
}

# ── 下载 ────────────────────────────────────────────────────────
$pkgPath = Join-Path $ProjectRoot ".tmp\$NodePkg"
Write-Info "下载 $NodeUrl"
try {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $NodeUrl -OutFile $pkgPath -UseBasicParsing -TimeoutSec 300
} catch {
  Die "下载失败: $($_.Exception.Message)`n请手动下载 $NodeUrl 并解压到 $NodeDir"
}

$size = (Get-Item $pkgPath).Length
if ($size -lt 1000000) { Die "下载文件过小（${size}B），疑似失败" }
Write-Info "已下载 $([math]::Round($size / 1MB)) MB"

# ── 解压 ────────────────────────────────────────────────────────
Write-Info "解压"
$extractDir = Join-Path $ProjectRoot '.tmp\node-extract'
if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

if ($NodePkgExt -eq 'zip') {
  Expand-Archive -Path $pkgPath -DestinationPath $extractDir -Force
} else {
  tar -xJf $pkgPath -C $extractDir
}

$inner = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
if (-not $inner) { Die "解压结果为空，包可能损坏" }

Move-Item -Path $inner.FullName -Destination $NodeDir

# ── 版本校验 ────────────────────────────────────────────────────
Write-Info "校验版本"
if (-not (Test-NodeReady)) {
  $actual = Get-NodeVersionOf
  Remove-Item -Recurse -Force $NodeDir
  Die "版本校验失败：期望 $NodeVersion，实际 $actual"
}
Write-Ok "Node $(& $NodeBin -v) 就绪"

# ── 清理 ────────────────────────────────────────────────────────
Remove-Item -Force $pkgPath -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue

Write-Host ""
Write-Ok "工具链已就位：$NodeBin"
Write-Info "npm 缓存 -> $ProjectRoot\.cache\npm"
Write-Host ""
Write-Host "下一步:"
Write-Host "  .\scripts\dev.ps1        开发模式"
Write-Host "  .\scripts\build.ps1      生产构建"
Write-Host ""
