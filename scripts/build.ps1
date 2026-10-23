# 生产构建。
#
# 用法:
#   .\scripts\build.ps1            # 前端 + 服务端 bundle
#   .\scripts\build.ps1 -Sea       # 额外产出本机平台单二进制

param(
  [switch]$Sea
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/toolchain.ps1')

Assert-Node
Initialize-Tmp
Set-Location $ProjectRoot

if (-not (Test-Path 'node_modules')) {
  Write-Info "安装依赖"
  & $NpmBin ci --cache (Join-Path $ProjectRoot '.cache/npm')
  if ($LASTEXITCODE -ne 0) { Die "依赖安装失败" }
}

Write-Info "构建前端"
& $NodeBin scripts/build-client.mjs
if ($LASTEXITCODE -ne 0) { Die "前端构建失败" }

Write-Info "构建服务端 bundle"
& $NodeBin scripts/build-server.mjs
if ($LASTEXITCODE -ne 0) { Die "服务端构建失败" }

if ($Sea) {
  Write-Info "打包单二进制"
  & $NodeBin scripts/build-sea.mjs
  if ($LASTEXITCODE -ne 0) { Die "SEA 构建失败" }
}

Write-Ok "构建完成"
