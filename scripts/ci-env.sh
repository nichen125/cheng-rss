#!/usr/bin/env bash
# CI 用：把项目内 node / npm 的**绝对路径**交给后续 step。
#
# 为什么需要它：workflow 里每一步都是独立的 shell，不能像 .sh 脚本那样
# `. toolchain.sh` 一次就带着变量往下走。GitHub 提供的通道是 $GITHUB_ENV
# 和 $GITHUB_PATH，但这个脚本只用 $GITHUB_ENV 写具体路径，**不写 PATH** ——
# 原因见下。
#
# 两次踩过的坑，都是"两个平台路径形态不同"这一件事：
#
#   1. `bin/npm` 是 `#!/usr/bin/env node`，依赖 PATH 里有 node。
#      一碰就 127。Windows 反而不报错（npm.cmd 用 %~dp0 自己找 node.exe），
#      于是同一个 bug 在第二个平台上被掩盖了。
#   2. npm 的 JS 入口两平台位置不同：
#        Windows 包（扁平）      node_modules/npm/bin/npm-cli.js
#        Linux 包（有 lib/）     lib/node_modules/npm/bin/npm-cli.js
#      写死一个必然在另一个平台失败。
#
# 结论：不去拼 PATH，也不在 workflow 里按平台分支。让这个脚本探测出
# 真实路径，写进 $GITHUB_ENV，后续 step 直接用 `"$NODE_BIN" "$NPM_CLI"`。
#
# 用法（workflow 里）:
#   - run: bash scripts/ci-env.sh
#   - run: "$NODE_BIN" "$NPM_CLI" ci
#
# 本地调试时没设 $GITHUB_ENV，脚本会直接把值打印出来。

set -euo pipefail

TOOLCHAIN_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/lib" && pwd)
export TOOLCHAIN_LIB_DIR
# shellcheck source=lib/toolchain.sh
. "$TOOLCHAIN_LIB_DIR/toolchain.sh"

require_node

if [ -z "${NPM_CLI:-}" ] || [ ! -f "$NPM_CLI" ]; then
  printf '\033[31m✗\033[0m 找不到 npm-cli.js（NODE_DIR=%s）\n' "$NODE_DIR" >&2
  printf '  期望其一：\n' >&2
  printf '    %s/lib/node_modules/npm/bin/npm-cli.js\n' "$NODE_DIR" >&2
  printf '    %s/node_modules/npm/bin/npm-cli.js\n' "$NODE_DIR" >&2
  exit 1
fi

# 转成绝对路径：后续 step 的 cwd 不一定是项目根
NODE_ABS="$NODE_BIN"
NPM_ABS="$NPM_CLI"
case "$NODE_ABS" in /*) ;; *) NODE_ABS="$PROJECT_ROOT/${NODE_ABS#"$PROJECT_ROOT"/}" ;; esac
case "$NPM_ABS"  in /*) ;; *) NPM_ABS="$PROJECT_ROOT/$NPM_ABS" ;; esac

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'NODE_BIN=%s\n' "$NODE_ABS"
    printf 'NPM_CLI=%s\n'  "$NPM_ABS"
  } >> "$GITHUB_ENV"
  printf '已写入 $GITHUB_ENV:\n'
fi

printf 'NODE_BIN=%s\n' "$NODE_ABS"
printf 'NPM_CLI=%s\n'  "$NPM_ABS"

# 自检：两个文件都得能跑。写错路径的代价是后面每一步都报看不懂的错，
# 不如在这里当场失败。
"$NODE_ABS" -v
"$NODE_ABS" "$NPM_ABS" --version
