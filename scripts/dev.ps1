# 开发模式：用项目内 Node 启动，热重载。
#
# 用法:
#   .\scripts\dev.ps1

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/toolchain.ps1')

Assert-Node
Initialize-Tmp

Set-Location $ProjectRoot

if (-not (Test-Path 'node_modules')) {
  Write-Warn2 "node_modules 缺失，先安装依赖"
  & $NpmBin ci --cache (Join-Path $ProjectRoot '.cache/npm')
  if ($LASTEXITCODE -ne 0) { Die "依赖安装失败" }
}

Write-Info "Node $(& $NodeBin -v)  项目 $ProjectRoot"
& $NodeBin --watch --experimental-strip-types src/index.ts @Rest
