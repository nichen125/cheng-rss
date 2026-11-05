#!/bin/sh
# 开发模式：用项目内 Node 启动，热重载。
#
# 用法:
#   ./scripts/dev.sh              # 启动 dev server
#   ./scripts/dev.sh --help

set -eu

TOOLCHAIN_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/lib" && pwd)
export TOOLCHAIN_LIB_DIR
# shellcheck source=scripts/lib/toolchain.sh
. "$TOOLCHAIN_LIB_DIR/toolchain.sh"

require_node
prepare_tmp

cd "$PROJECT_ROOT"

if [ ! -d "node_modules" ]; then
  warn "node_modules 缺失，先安装依赖"
  # 同 build.sh：用 node 直调 npm-cli.js，绕开依赖 PATH 的 bin/npm
  "$NODE_BIN" "$NPM_CLI" ci --cache "$PROJECT_ROOT/.cache/npm" || die "依赖安装失败"
fi

info "Node $("$NODE_BIN" -v)  项目 $PROJECT_ROOT"
exec "$NODE_BIN" --watch --experimental-strip-types src/index.ts "$@"
