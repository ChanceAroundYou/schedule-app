#!/bin/sh
# 把后端的 AI 依赖装到**本机磁盘**，再在仓库里放一个指向它的 node_modules 软链。
#
# 为什么不直接 `npm install` 就完事：
#   工程目录挂在 NAS 的 CIFS 上。同一组依赖装在本机磁盘 10 秒，装在共享盘上
#   实测 5 分钟（101 MB / 87 个包，逐个小文件过 SMB）。CLAUDE.md 四、30 还记着
#   那个共享盘真的丢过文件 —— 丢源码要命，丢 node_modules 只是重装，
#   但没必要把上万个文件送上去。
#
# 为什么是软链而不是 NODE_PATH：
#   pi-agent-core / pi-ai 是 ESM-only（package.json 的 exports 里没有 require
#   条件），CommonJS 的 `require()` 直接报 ERR_PACKAGE_PATH_NOT_EXPORTED，
#   只能用 `await import()`。而 **ESM 解析器不认 NODE_PATH**，只走 node_modules
#   逐级上溯。软链两个解析器都认，所以不用往 systemd 里加 Environment。
#
# ⚠️ 别在仓库根目录直接跑 `npm install` —— npm 的 reify 会把这个软链当成
#    「非目录」删掉，然后就地建一个真目录，于是又回到共享盘上。
#    要装依赖就跑这个脚本。
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPS=${SCHEDULE_DEPS_DIR:-$HOME/.local/schedule/deps}

mkdir -p "$DEPS"
cp "$ROOT/package.json" "$DEPS/package.json"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$DEPS/package-lock.json"

npm install --prefix "$DEPS" --omit=dev --no-audit --no-fund
cp "$DEPS/package-lock.json" "$ROOT/package-lock.json"

# -n：目标是目录时不套一层多余的软链
ln -sfn "$DEPS/node_modules" "$ROOT/node_modules"

echo
echo "依赖已装到  $DEPS/node_modules"
echo "仓库里的软链  $ROOT/node_modules"
