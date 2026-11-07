#!/usr/bin/env bash
#
# 发布一个新版 APK 到服务器，供 App 自更新拉取。
#
#   ./deploy/publish-apk.sh                 # 用当天日期当更新说明
#   ./deploy/publish-apk.sh "修了打卡回弹"   # 自己写说明
#
# 做五件事：
#   1. assembleRelease（用 keystore.properties 里的固定 keystore 签名）
#   2. 从 APK 里读 versionCode / versionName（不信 build.gradle，信产物本身）
#   3. scp 到服务器 ~/.local/schedule/apk/schedule-<versionCode>.apk，
#      连同算好的 sha256 一起写进 version.json
#   4. curl 回读校验，确认客户端真能拿到
#   5. 把版本/提交/分支写进 ~/.local/schedule/state/app.version
#      （2026-10-17 补：以前漏了这步，线上记录停在旧版本不更新）
#
# ⚠️ 前置条件：
#   · app/android/keystore.properties 必须在（密码在里面），否则 release 未签名
#   · versionCode 必须比线上大。**每次发版都要手改 app/build.gradle 的
#     versionCode** —— 客户端只认「大于才更新」，忘了加就永远提示不了。
#
# ⚠️ 签名不可换：换 keystore = 覆盖安装失败 = 用户必须卸载重装（数据丢）。
#    keystore 在 C:/Users/小哭包/.android/schedule-release.jks，**要备份**。
#
# 对应服务端目录：/home/xiaokubao/.local/schedule/apk（本机磁盘，不是 NAS）
# nginx 位置：/schedule/dl/，见 deploy/schedule.conf

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID="$ROOT/app/android"

# JDK / SDK / Gradle / SSH_HOST / BASE_URL 全部由 .env + 平台探测决定（见 deploy/env.sh）。
# AAPT 也由它提供（挑 build-tools 里版本最大的那个）—— 这里**不再写死某个用户名下的
# 绝对路径、也不写死 build-tools 版本**（2026-10-26 合流时统一收口）。
source "$ROOT/deploy/env.sh"
env_require

SSH_HOST="${SSH_HOST:-ubuntu}"
REMOTE_DIR='~/.local/schedule/apk'
# 必须用 Windows 自带的 ssh.exe —— Git Bash 的 MSYS 版 ssh 不读 ~/.ssh/config
# 里的 Host 别名（`ssh ubuntu` 会退化成用本机名当用户名，然后 publickey 失败）
# ssh 可执行文件由 preflight.sh 的 pick_ssh() 探测：
#   显式 `SSH=` → Windows 自带的 ssh.exe → PATH 里的 ssh。
# **别在这里再写死某个平台的路径** —— 那样 Linux 侧会静默失败。
# 注意也别在这里给 SSH 赋任何值，会盖掉用户传进来的那个。
BASE_URL="${BASE_URL%/}/dl"

# 版本记录（state/app.version）与 publish-web.sh 对齐，靠 preflight.sh 的
# pf_gather / pf_write_version。⚠️ 2026-10-17 补的：以前这里没有，发完 APK
# 线上记录不更新（上上个版本就停更过）。
source "$ROOT/deploy/preflight.sh"

NOTES="${1:-$(date '+%Y-%m-%d 发布')}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ANDROID/keystore.properties" ] \
  || die "缺 app/android/keystore.properties —— 没有它 release 包不签名，装了也没法后续自更新"

say "1/4 编译 release"
# APK 里打包的是 app/android/app/src/main/assets/public，那份是 `npx cap copy`
# 从 dist/ 拷进去的。改了网页却没同步的话，APK 里会是旧界面（线上 nginx 读的是
# dist/，所以网页看不出问题，只有 App 离线时露出旧版）。这里比一下 index.html，
# 不一致就拒绝 —— 不自动跑 cap copy，那要 node 环境，交给发版的人决定。
if [ -f "$ROOT/dist/index.html" ] && [ -f "$ANDROID/app/src/main/assets/public/index.html" ]; then
  if [ "$(md5sum < "$ROOT/dist/index.html" | cut -d' ' -f1)" != \
       "$(md5sum < "$ANDROID/app/src/main/assets/public/index.html" | cut -d' ' -f1)" ]; then
    printf '\033[1;33m!! dist/ 与 APK 内置资源不一致 —— 先跑 `cd app && npx cap copy android`\033[0m\n'
    die "内置网页资源过期，拒绝发布"
  fi
fi
cd "$ANDROID"
# 走 deploy/gradle.sh 而不是 env.sh 的 $GRADLE：后者默认是仓库 wrapper（gradlew），
# 本机没配 .env 时会去下 230MB 发行版，表现为「卡半小时且没有任何输出」。
# gradle.sh 优先用 ~/gradle-dist 下已解压的那份，顺带锁 JDK 21 与 SDK。
"$ROOT/deploy/gradle.sh" :app:assembleRelease --quiet

# ⚠️ aapt.exe 是 **Windows 程序**，不认 Git Bash 的 `/c/...` 路径 —— 传绝对路径
# 进去它当成相对路径找，静默返回空，症状是「读不到 versionCode」。所以下面一律
# 用相对路径（已经 cd 到 app/android 了）。
APK_REL="app/build/outputs/apk/release/app-release.apk"
[ -f "$APK_REL" ] || die "没找到 $APK_REL"
APK_SIZE=$(wc -c < "$APK_REL" | tr -d ' ')
say "产物 app-release.apk  ${APK_SIZE} 字节"

say "2/4 读版本号 + 算 sha256（读产物，不信源码）"
BADGING="$("$AAPT" dump badging "$APK_REL" 2>/dev/null || true)"
VERSION_CODE="$(printf '%s\n' "$BADGING" | sed -n "s/^package:.*versionCode='\([0-9]*\)'.*/\1/p" | head -1)"
VERSION_NAME="$(printf '%s\n' "$BADGING" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" | head -1)"
[ -n "$VERSION_CODE" ] || die "aapt 读不到 versionCode（aapt 输出：$(printf '%s' "$BADGING" | head -c 200)）"
[ -n "$VERSION_NAME" ] || VERSION_NAME="?"
SHA="$(sha256sum "$APK_REL" | cut -d' ' -f1 | tr 'A-Z' 'a-z')"
printf '  versionCode=%s  versionName=%s\n  sha256=%s\n' "$VERSION_CODE" "$VERSION_NAME" "$SHA"

# ---------------------------------------------------------------------------
# 发布前身份校验（2026-11-07）。
#
# 为什么要有这一段：客户端只按「清单 versionCode 大于本机」提示更新，然后交给
# Android 系统安装器覆盖安装。包名不同、签名不同、versionCode 没递增，客户端
# 全都发现不了 —— 表现是「提示更新 → 下载完 → 安装器拒绝 / 装完还是旧版」，
# 也就是用户说的「更新时好时坏」。这些错误在**发布这一刻**就能挡住。
# ---------------------------------------------------------------------------
PKG_NAME="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
[ "$PKG_NAME" = "space.xiaokubao.schedule" ] \
  || die "APK 包名是 '${PKG_NAME}'，必须是 space.xiaokubao.schedule（否则装不上，只能卸载重装）"
printf '  包名校验通过：%s\n' "$PKG_NAME"

# 签名：apksigner 与 aapt 在同一个 build-tools 目录里。没有就只警告 ——
# 不同机器上 build-tools 的布局不完全一样，不能因为缺工具就阻断发版。
APKSIGNER="$(dirname "$AAPT")/apksigner"
if [ -x "$APKSIGNER" ] || [ -f "$APKSIGNER.bat" ]; then
  SIGN_OUT="$("$APKSIGNER" verify --print-certs "$APK_REL" 2>&1 || true)"
  printf '%s' "$SIGN_OUT" | grep -qi "certificate DN\|Signer #1" \
    || die "APK 签名校验没过（apksigner 输出：$(printf '%s' "$SIGN_OUT" | head -c 200)）"
  printf '  签名校验通过\n'
else
  printf '\033[1;33m!! 没找到 apksigner，跳过签名校验（签名不一致时安装器会拒绝）\033[0m\n'
fi

# versionCode 必须比线上大 —— 客户端只认「大于才更新」。
# 拉不到线上清单（断网 / 代理）只警告：此时仍允许发，但会说出来。
PUBLISHED="$(curl -s --noproxy '*' "$BASE_URL/version.json" || true)"
PUBLISHED_CODE="$(printf '%s' "$PUBLISHED" | sed -n 's/.*"versionCode" *: *\([0-9]*\).*/\1/p' | head -1)"
if [ -n "$PUBLISHED_CODE" ]; then
  if [ "$VERSION_CODE" -le "$PUBLISHED_CODE" ]; then
    die "线上已经是 versionCode $PUBLISHED_CODE，这次是 $VERSION_CODE —— 必须严格递增，否则客户端永远不会提示更新"
  fi
  printf '  版本递增校验通过：线上 %s → 本次 %s\n' "$PUBLISHED_CODE" "$VERSION_CODE"
else
  printf '\033[1;33m!! 没读到线上 version.json，跳过「版本必须递增」校验\033[0m\n'
fi

say "3/4 上传到 $SSH_HOST:$REMOTE_DIR"
APK_NAME="schedule-$VERSION_CODE.apk"
# 用 ssh 管道而不是 scp —— 这台 Windows 上的 scp 报 "pipe: Unknown error"
"$SSH" "$SSH_HOST" "mkdir -p $REMOTE_DIR && cat > $REMOTE_DIR/$APK_NAME" < "$APK_REL"

# version.json 一起传。字段名与 AppUpdate.java 里的 Manifest 一一对应
# （versionCode / versionName / url / sha256 / notes）。
#
# ⚠️ **不落临时文件**：以前用 `mktemp` + `trap 'rm -f ...' EXIT`，但 Git Bash 的
# mktemp 返回的是盘符路径（C:/...），收尾那个 rm 会被本机的安全删除钩子拦下、
# 报 SAFE_DELETE_INVALID_PATH —— 一个**已经发成功**的版本最后以非零码退出，
# 调用方（mobile-loop）据此判定「发布失败」，连装机都跳过了。
# 直接把 JSON 从 stdin 递过去，既少一次磁盘往返，也没有要清理的东西。
"$SSH" "$SSH_HOST" "cat > $REMOTE_DIR/version.json" <<EOF
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "url": "$APK_NAME",
  "sha256": "$SHA",
  "notes": "$NOTES",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
"$SSH" "$SSH_HOST" "ls -la $REMOTE_DIR"

say "4/4 回读校验"
GOT="$(curl -s --noproxy '*' "$BASE_URL/version.json")"
printf '  version.json -> %s\n' "$GOT"
printf '%s' "$GOT" | grep -q "\"versionCode\": *$VERSION_CODE" \
  || die "服务端返回的 versionCode 不是 $VERSION_CODE，发布可能没生效"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE_URL/$APK_NAME")"
[ "$CODE" = "200" ] || die "APK 下载返回 $CODE"
printf '  %s -> HTTP %s\n' "$APK_NAME" "$CODE"

say "5/5 写版本记录（~/.local/schedule/state/app.version）"
# pf_gather 会自己 cd 回仓库根采集 git 状态；上面 cd 到 android 目录不影响它。
pf_gather
pf_write_version app "$VERSION_NAME" "versionCode=$VERSION_CODE sha256=$SHA"

say "发布完成：$VERSION_NAME（versionCode $VERSION_CODE）"
printf '  手机下次冷启动 App 就会看到更新提示。\n'
