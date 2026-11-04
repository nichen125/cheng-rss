# 工具链共享逻辑（PowerShell），被 bootstrap.ps1 / dev.ps1 / build.ps1 dot-source。
# 与 scripts/lib/toolchain.sh 保持一一对应，任何一侧改动都要同步另一侧。

$ErrorActionPreference = 'Stop'

# ── 项目根：本文件位于 <root>/scripts/lib/toolchain.ps1 ─────────
$ToolchainLibDir = Split-Path -Parent $PSCommandPath
$ProjectRoot = (Resolve-Path (Join-Path $ToolchainLibDir '../..')).Path
$env:PROJECT_ROOT = $ProjectRoot

# ── 版本与路径约定 ──────────────────────────────────────────────
$DefaultNodeVersion = 'v24.13.0'
$NodeVersion = if ($env:CHENG_RSS_NODE_VERSION) { $env:CHENG_RSS_NODE_VERSION } else { $DefaultNodeVersion }

$ToolchainDir = Join-Path $ProjectRoot '.toolchain'
$NodeDir = Join-Path $ToolchainDir 'node'
$NodeBin = Join-Path $NodeDir 'node.exe'
$NpmBin = Join-Path $NodeDir 'npm.cmd'

$Platform = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'win-x64' }
            elseif ($IsMacOS) { 'darwin-arm64' }
            elseif ($IsLinux) { 'linux-x64' }
            else { throw "不支持的平台" }

$NodePkgExt = if ($Platform -eq 'win-x64') { 'zip' } else { 'tar.xz' }
$NodePkg = "node-$NodeVersion-$Platform.$NodePkgExt"
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodePkg"

# ── 输出 ────────────────────────────────────────────────────────
function Write-Info($msg) { Write-Host "  $msg" }
function Write-Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "!   $msg" -ForegroundColor Yellow }
function Die($msg)         { Write-Host "ERR $msg" -ForegroundColor Red; exit 1 }

# ── 就绪判定 ────────────────────────────────────────────────────
function Test-NodeReady {
  if (-not (Test-Path $NodeBin)) { return $false }
  try {
    $actual = (& $NodeBin -v 2>$null)
    return ($actual -eq $NodeVersion)
  } catch { return $false }
}

function Get-NodeVersionOf {
  if (Test-Path $NodeBin) { try { return (& $NodeBin -v 2>$null) } catch { return '损坏' } }
  return '未安装'
}

function Assert-Node {
  if (-not (Test-NodeReady)) {
    Die "项目内 Node 未就绪（期望 $NodeVersion，实际 $(Get-NodeVersionOf)）。先运行: .\scripts\bootstrap.ps1"
  }
}

# 临时目录留在项目内
function Initialize-Tmp {
  $tmp = Join-Path $ProjectRoot '.tmp'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $env:TMPDIR = $tmp; $env:TMP = $tmp; $env:TEMP = $tmp
}
