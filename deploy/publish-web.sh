#!/usr/bin/env bash
#
# 发布**网页版**前端到服务器。
#
#   ./deploy/publish-web.sh                    # 构建 + dry-run（只看不发布）
#   ./deploy/publish-web.sh --approve          # 构建 + 真的发布
#   ./deploy/publish-web.sh --approve --skip-build # 已有 dist/，不再构建
#   ./deploy/publish-web.sh --approve --force  # 不看指纹，强制重发
#   ./deploy/publish-web.sh --approve --rollback # 回滚到上一份备份
#
# ⚠️ **默认 dry-run**：不加 --approve 就只打印「要发什么、发到哪、来源分支是
#    哪个提交」，**绝不写生产**。这是双端开发下生产锁定的那道闸门 ——
#    任何自动化（定时器、批量操作）都不会越过你发出去。
#
# 做六件事：
#   1. 本地 `npm run build`（**同源**，不带 VITE_API_BASE —— 那是 APK 用的）
#   2. 跟线上的 web/ 比内容指纹 —— **一样就不上传、不备份、不切换**
#   3. 前置校验 + 授权（deploy/preflight.sh）：分支 / HEAD / 干净 / 已推送
#   4. tar 管道传到远端**临时目录**（不是直接盖当前版本，避免传一半被读到）
#   5. 现有版本整份备份成 web.bak-<版本>-<时间>，保留最近 3 份
#   6. 换掉目录内容 + 回读校验 + 写 state/web.version
#
# ⚠️ **为什么要有这个脚本**（2026-10-15）：
# 以前 nginx 把整个 SMB 工程目录挂成 /data/schedule、alias 指向它的 dist/，
# 于是「本地 build 一下覆盖 SMB 那份」**就等于上线** —— 构建产物落在多设备共享
# 的源码目录里，没有发布动作、没有备份、没有回滚，而且那份目录你在别的设备
# 上也一直在动。现在前端产物在服务器本机磁盘 ~/.local/schedule/web/，
# 工程里的 dist/ 只是本地产物，**发布必须显式跑这个脚本 + 显式 --approve**。
#
# 回滚不用 git：备份就在同层目录，服务器本机磁盘，拷回去是秒级。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"

SSH_HOST="${SSH_HOST:-ubuntu}"
# 必须用 Windows 自带的 ssh.exe —— Git Bash 的 MSYS 版不读 ~/.ssh/config 里的别名
SSH="${SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REMOTE_WEB='~/.local/schedule/web'
BASE_URL="${BASE_URL:-https://home.xiaokubao.space/schedule}"
KEEP=3

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# shellcheck source=preflight.sh
source "$ROOT/deploy/preflight.sh"
pf_parse_args "$@"

# dist 的**内容**指纹：逐文件 sha256 再汇总。只看内容、不看 mtime。
#
# ⚠️ 中间那道 `sed 's/\*//g' | tr -s ' '` 是必需的，别删：Git Bash 的 sha256sum
#    走二进制模式输出 `HASH *路径`，Linux 上是文本模式输出 `HASH  路径`，
#    不归一化的话两边永远对不上（publish-server.sh 里踩过）。
FP_CMD="find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sed 's/\*//g' | tr -s ' ' | sha256sum | cut -c1-16"

# ---------------------------------------------------------------- 回滚
if [ "${1:-}" = "--rollback" ]; then
  say "回滚：列出备份"
  LAST="$("$SSH" "$SSH_HOST" "ls -1d $REMOTE_WEB.bak-* 2>/dev/null | sort | tail -1")"
  [ -n "$LAST" ] || die "没有找到任何备份（$REMOTE_WEB.bak-*）"
  pf_gather
  pf_print_summary "$REMOTE_WEB" "动作=回滚到 $LAST"
  pf_approve_or_exit
  printf '  回滚到：%s\n' "$LAST"
  # 同样**不能 mv 目录**（bind mount 认 inode），只把内容拷回去
  "$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_WEB
cp -r $REMOTE_WEB $REMOTE_WEB.bak-rollback-$(date +%m%d-%H%M%S)
rm -rf $REMOTE_WEB/*
cp -r $LAST/. $REMOTE_WEB/"
  pf_write_version web "" "rollback to $(basename "$LAST")"
  say "回滚完成，回读校验"
  curl -s --noproxy '*' -o /dev/null -w '  index=%{http_code}\n' "$BASE_URL/"
  exit 0
fi

# ---------------------------------------------------------------- 构建
if [ "${1:-}" = "--skip-build" ]; then
  say "1/6 跳过构建（--skip-build），用现有 dist/"
else
  say "1/6 本地构建（同源，不带 VITE_API_BASE）"
  cd "$APP"
  npm run build
fi
cd "$ROOT"
[ -f dist/index.html ] || die "没有 dist/index.html —— 先构建"
[ -d dist/assets ] || die "dist/assets 不存在"

# 版本写进备份名，便于「回滚到哪个版本」有据可依。
# 用 grep 而不是 `node -p require(...)`：这里是 Windows 的 node，
# require('/c/Users/...') 这种 Git Bash 路径它解析不了。
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP/package.json" | head -1)"
[ -n "$VERSION" ] || VERSION="unknown"
TS="$(date +%m%d-%H%M%S)"

# ---------------------------------------------------------------- 指纹比对
say "2/6 跟线上比内容指纹"
LOCAL_FP="$(cd dist && eval "$FP_CMD")"
REMOTE_FP="$("$SSH" "$SSH_HOST" "cd $REMOTE_WEB 2>/dev/null && $FP_CMD" || true)"
printf '  本地 %s\n  线上 %s\n' "${LOCAL_FP:-<空>}" "${REMOTE_FP:-<空>}"
SKIP=0
if [ "$PF_FORCE" = "0" ] && [ -n "$LOCAL_FP" ] && [ "$LOCAL_FP" = "$REMOTE_FP" ]; then
  SKIP=1
else
  [ "$PF_FORCE" = "1" ] && printf '  --force：跳过比对，照发\n'
fi

# ---------------------------------------------------------------- 授权闸门
pf_gather
if [ "$SKIP" = "1" ]; then
  # 线上已经是这份内容 —— 不会写生产，所以不需要授权，但仍然把来源状态摆出来
  say "无变更 → 不上传 / 不备份 / 不切换"
  pf_print_summary "$REMOTE_WEB" "内容指纹一致，本次不会改动生产"
else
  say "3/6 前置校验 + 授权"
  pf_gate "$REMOTE_WEB" \
    "内容指纹  线上与本地不同，将整份替换" \
    "备份      将在服务器上留 web.bak-$VERSION-$TS（保留最近 $KEEP 份）"
fi

# ---------------------------------------------------------------- 上传
if [ "$SKIP" = "0" ]; then
say "4/6 传到远端临时目录"
"$SSH" "$SSH_HOST" "rm -rf $REMOTE_WEB.new && mkdir -p $REMOTE_WEB.new"
tar -czf - -C dist . | "$SSH" "$SSH_HOST" "tar -xzf - -C $REMOTE_WEB.new && echo '    解包 ok'"

# ---------------------------------------------------------------- 备份 + 切换
say "5/6 备份现有版本 → 切换"
# ⚠️ **只换目录里的东西，绝不 mv 目录本身**（2026-10-15 实测踩的）：
# Docker 的 bind mount 认的是 **inode**。把目录 mv 走、再把新目录 mv 上来，
# 容器里那个挂载点还指着旧 inode —— 而旧目录已经被删了，于是 nginx 立刻 403
# `directory index of "/data/schedule-web/" is forbidden`，而且**重启容器前
# 不会自愈**。所以目标目录的 inode 从建好那天起就不能变。
"$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_WEB
if [ -f $REMOTE_WEB/index.html ]; then
  cp -r $REMOTE_WEB $REMOTE_WEB.bak-$VERSION-$TS
  echo \"    已备份 web.bak-$VERSION-$TS\"
fi
rm -rf $REMOTE_WEB/*
cp -r $REMOTE_WEB.new/. $REMOTE_WEB/
rm -rf $REMOTE_WEB.new
# 只留最近 $KEEP 份
ls -1d $REMOTE_WEB.bak-* 2>/dev/null | sort | head -n -$KEEP | while read -r d; do rm -rf \"\$d\"; echo \"    清掉旧备份 \$(basename \$d)\"; done
ls -1d $REMOTE_WEB.bak-* 2>/dev/null | sed 's/^/    /' || true"
fi

# ---------------------------------------------------------------- 校验
say "6/6 回读校验"
LOCAL_HASHES="$(grep -o 'index-[A-Za-z0-9_-]*\.\(js\|css\)' dist/index.html | sort)"
printf '  本地 index.html 引用：\n%s\n' "$(printf '%s' "$LOCAL_HASHES" | sed 's/^/    /')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE_URL/")"
[ "$CODE" = "200" ] || die "线上首页返回 $CODE"
ONLINE="$(curl -s --noproxy '*' "$BASE_URL/")"
for h in $LOCAL_HASHES; do
  printf '%s' "$ONLINE" | grep -q "$h" || die "线上 index.html 里没有 $h —— 发布可能没生效"
done
for h in $LOCAL_HASHES; do
  C="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE_URL/assets/$h")"
  [ "$C" = "200" ] || die "$h 下载返回 $C"
  printf '    %s -> HTTP %s\n' "$h" "$C"
done

if [ "$SKIP" = "0" ]; then
  pf_write_version web "$VERSION"
  say "发布完成（$VERSION）"
else
  say "未改动生产（线上已是这份内容）"
fi
printf '  回滚：./deploy/publish-web.sh --approve --rollback\n'
