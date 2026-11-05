#!/bin/sh
# 生产构建。
#
# 用法:
#   ./scripts/build.sh             # 前端 + 服务端 bundle
#   ./scripts/build.sh --sea       # 额外产出本机平台单二进制

set -eu

TOOLCHAIN_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/lib" && pwd)
export TOOLCHAIN_LIB_DIR
# shellcheck source=scripts/lib/toolchain.sh
. "$TOOLCHAIN_LIB_DIR/toolchain.sh"

require_node
prepare_tmp
cd "$PROJECT_ROOT"

WANT_SEA=0
for arg in "$@"; do
  case "$arg" in
    --sea) WANT_SEA=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "未知参数: $arg" ;;
  esac
done

if [ ! -d "node_modules" ]; then
  info "安装依赖"
  # 用 node 直调 npm-cli.js，不用 $NPM_BIN。
  # $NPM_BIN 在 *nix 上是 bin/npm，shebang 为 `#!/usr/bin/env node`，
  # 依赖 PATH 里有 node —— 在本机开发时通常成立，所以这个 bug 平时
  # 看不出来，一旦在没配 PATH 的环境（CI、干净的服务器）里跑就 127。
  "$NODE_BIN" "$NPM_CLI" ci --cache "$PROJECT_ROOT/.cache/npm" || die "依赖安装失败"
fi

info "构建前端"
"$NODE_BIN" scripts/build-client.mjs || die "前端构建失败"

info "构建服务端 bundle"
"$NODE_BIN" scripts/build-server.mjs || die "服务端构建失败"

if [ "$WANT_SEA" -eq 1 ]; then
  info "打包单二进制"
  "$NODE_BIN" scripts/build-sea.mjs || die "SEA 构建失败"
fi

ok "构建完成"
