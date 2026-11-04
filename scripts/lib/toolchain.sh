#!/bin/sh
# 工具链共享逻辑（POSIX sh），被 bootstrap.sh / dev.sh / build.sh 加载。
# 唯一职责：定位项目内的 node，绝不读系统 PATH 里的 node 作为主路径。
#
# 设计约束（见 PLAN.md §4.3）：
#   1. 所有路径相对项目根，脚本从任何目录调用都能工作
#   2. 项目内 node 优先；系统 node 仅在 bootstrap 提示时提及
#   3. 版本必须与 CHENG_RSS_NODE_VERSION 一致，否则报错退出

set -eu

# ── 项目根：本文件位于 <root>/scripts/lib/toolchain.sh ──────────
# 被 source 时 $0 是调用者脚本而非本文件，不能靠 $0 反推。
# 因此要求调用方先设置 TOOLCHAIN_LIB_DIR（各脚本都已在 source 前算好）。
# 未设置时按"本文件由 <root>/scripts/xxx.sh source"的约定兜底：
# $0 = <root>/scripts/xxx.sh → 上两级即项目根。
if [ -z "${TOOLCHAIN_LIB_DIR:-}" ]; then
  TOOLCHAIN_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/lib" 2>/dev/null && pwd) \
    || { printf '无法定位 scripts/lib，请在 source 前设置 TOOLCHAIN_LIB_DIR\n' >&2; exit 1; }
fi
PROJECT_ROOT=$(CDPATH= cd -- "$TOOLCHAIN_LIB_DIR/../.." && pwd)
export PROJECT_ROOT TOOLCHAIN_LIB_DIR

# ── 版本与路径约定 ──────────────────────────────────────────────
DEFAULT_NODE_VERSION="v24.13.0"
NODE_VERSION="${CHENG_RSS_NODE_VERSION:-$DEFAULT_NODE_VERSION}"

TOOLCHAIN_DIR="$PROJECT_ROOT/.toolchain"
NODE_DIR="$TOOLCHAIN_DIR/node"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win-x64"; NODE_BIN="$NODE_DIR/node.exe" ;;
  Linux*)               PLATFORM="linux-x64"; NODE_BIN="$NODE_DIR/bin/node" ;;
  Darwin*)              PLATFORM="darwin-arm64"; NODE_BIN="$NODE_DIR/bin/node" ;;
  *) printf '不支持的平台: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac
export PLATFORM NODE_BIN

# 下载压缩包用的扩展名
case "$PLATFORM" in
  win-x64) NODE_PKG_EXT="zip" ;;
  *)       NODE_PKG_EXT="tar.xz" ;;
esac
NODE_PKG="node-${NODE_VERSION}-${PLATFORM}.${NODE_PKG_EXT}"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_PKG}"

# ── 输出帮助函数（保持简短，不引入额外依赖）────────────────────
info() { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 判定项目内 node 是否已就绪且版本正确 ────────────────────────
node_ready() {
  [ -x "$NODE_BIN" ] || return 1
  actual=$("$NODE_BIN" -v 2>/dev/null || echo none)
  [ "$actual" = "$NODE_VERSION" ]
}

node_version_of() {
  [ -x "$NODE_BIN" ] && "$NODE_BIN" -v 2>/dev/null || echo "未安装"
}

# ── npm/npx：始终用项目内 node 自带的那份 ───────────────────────
case "$PLATFORM" in
  win-x64) NPM_BIN="$NODE_DIR/npm.cmd"; NPX_BIN="$NODE_DIR/npx.cmd" ;;
  *)       NPM_BIN="$NODE_DIR/bin/npm"; NPX_BIN="$NODE_DIR/bin/npx" ;;
esac
export NPM_BIN NPX_BIN

require_node() {
  node_ready || die "项目内 Node 未就绪（期望 $NODE_VERSION，实际 $(node_version_of)）。先运行: ./scripts/bootstrap.sh"
}

# 统一设置临时目录到项目内，防止 TMP 写到系统临时区
prepare_tmp() {
  mkdir -p "$PROJECT_ROOT/.tmp"
  TMPDIR="$PROJECT_ROOT/.tmp"; TMP="$TMPDIR"; TEMP="$TMPDIR"
  export TMPDIR TMP TEMP
}
