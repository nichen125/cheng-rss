#!/usr/bin/env bash
# 下载并部署项目内 Node 运行时到 .toolchain/node/。
#
# 只需运行一次。之后 dev.sh / build.sh 都直接用 .toolchain/node，
# 不再依赖系统 Node。
#
# 用法：
#   ./scripts/bootstrap.sh              # 装默认版本 v24.13.0
#   AI_RSS_NODE_VERSION=v24.14.0 ./scripts/bootstrap.sh
#   ./scripts/bootstrap.sh --force      # 强制重装（校验失败时用）

set -euo pipefail

# 不能用 sh：需要 pipefail 与更可靠的路径处理
TOOLCHAIN_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/lib" && pwd)
export TOOLCHAIN_LIB_DIR
# shellcheck source=scripts/lib/toolchain.sh
. "$TOOLCHAIN_LIB_DIR/toolchain.sh"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "未知参数: $arg" ;;
  esac
done

prepare_tmp
mkdir -p "$TOOLCHAIN_DIR" "$PROJECT_ROOT/.cache/npm"

printf '\n\033[1m引导项目内 Node 运行时\033[0m\n'
info "版本   $NODE_VERSION"
info "平台   $PLATFORM"
info "目标   $NODE_DIR"

if node_ready && [ "$FORCE" -eq 0 ]; then
  ok "已就绪（$(node_version_of)），跳过下载"
  printf '\n下一步: ./scripts/dev.sh\n\n'
  exit 0
fi

if [ -d "$NODE_DIR" ]; then
  warn "移除旧的 .toolchain/node"
  rm -rf "$NODE_DIR"
fi

# ── 下载 ────────────────────────────────────────────────────────
PKG_PATH="$PROJECT_ROOT/.tmp/$NODE_PKG"
info "下载 $NODE_URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
       -o "$PKG_PATH" "$NODE_URL" || die "下载失败: $NODE_URL"
else
  die "未找到 curl，无法下载。请手动下载 $NODE_URL 并解压到 $NODE_DIR"
fi

SIZE=$(wc -c < "$PKG_PATH" | tr -d ' ')
[ "$SIZE" -gt 1000000 ] || die "下载文件过小（${SIZE}B），疑似失败"
info "已下载 $((SIZE / 1048576)) MB"

# ── 解压 ────────────────────────────────────────────────────────
info "解压"
EXTRACT_DIR="$PROJECT_ROOT/.tmp/node-extract"
rm -rf "$EXTRACT_DIR"; mkdir -p "$EXTRACT_DIR"

case "$NODE_PKG_EXT" in
  zip)
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "$PKG_PATH" -d "$EXTRACT_DIR"
    else
      # Git Bash 自带 tar 也能解 zip
      tar -xf "$PKG_PATH" -C "$EXTRACT_DIR"
    fi
    ;;
  tar.xz)
    tar -xJf "$PKG_PATH" -C "$EXTRACT_DIR"
    ;;
esac

# 官方包解压后是单层目录 node-vX.Y.Z-<plat>/
INNER=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$INNER" ] || die "解压结果为空，包可能损坏"

# win 包是扁平结构（node.exe 直接在根），nix 包有 bin/ 子目录
mv "$INNER" "$NODE_DIR"

# ── 版本校验 ────────────────────────────────────────────────────
info "校验版本"
if ! node_ready; then
  ACTUAL=$(node_version_of)
  rm -rf "$NODE_DIR"
  die "版本校验失败：期望 $NODE_VERSION，实际 $ACTUAL"
fi
ok "Node $("$NODE_BIN" -v) 就绪"

# ── 清理下载缓存，避免 .tmp 长期占用 ────────────────────────────
rm -rf "$PKG_PATH" "$EXTRACT_DIR"

printf '\n'
ok "工具链已就位：$NODE_BIN"
info "npm 缓存 -> $PROJECT_ROOT/.cache/npm"
printf '\n下一步:\n  ./scripts/dev.sh        开发模式\n  ./scripts/build.sh      生产构建\n\n'
