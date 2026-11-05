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

# ── npm-cli.js：给 CI 用的、不依赖 PATH 的入口 ──────────────────
#
# NPM_BIN 是个 wrapper：win 的 npm.cmd 用 %~dp0 找 node.exe（可行），
# 但 *nix 的 bin/npm 是 `#!/usr/bin/env node` —— 它要求 PATH 里有 node。
# CI 的 step 里没有，直接以 127 失败。
#
# 所以这里直接给出 npm 的 JS 入口，调用方写成 `"$NODE_BIN" "$NPM_CLI"`：
# node 已经在手上，就不再需要 PATH，也不再需要按平台分支。
#
# **路径形态两平台不同**，这是踩过的第二个坑：
#   Windows 包（zip，扁平）      → $NODE_DIR/node_modules/npm/bin/npm-cli.js
#   Linux  包（tar.xz，有 lib/） → $NODE_DIR/lib/node_modules/npm/bin/npm-cli.js
# 写死其中一个是错的。探测而不是分支 —— 分支要多维护一处，探测不会漂。
#
# 不用 `local`：本文件被 build.sh / dev.sh 以 `#!/bin/sh` source，而 local
# 是 bash 扩展，dash 下会报错。位置参数本身就是这里的局部变量，够用。
npm_cli_path() {
  if [ -f "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" ]; then
    printf '%s' "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
  elif [ -f "$NODE_DIR/node_modules/npm/bin/npm-cli.js" ]; then
    printf '%s' "$NODE_DIR/node_modules/npm/bin/npm-cli.js"
  else
    printf ''
  fi
}
NPM_CLI="$(npm_cli_path)"
export NPM_CLI

require_node() {
  node_ready || die "项目内 Node 未就绪（期望 $NODE_VERSION，实际 $(node_version_of)）。先运行: ./scripts/bootstrap.sh"
}

# 统一设置临时目录到项目内，防止 TMP 写到系统临时区
prepare_tmp() {
  mkdir -p "$PROJECT_ROOT/.tmp"
  TMPDIR="$PROJECT_ROOT/.tmp"; TMP="$TMPDIR"; TEMP="$TMPDIR"
  export TMPDIR TMP TEMP
}
