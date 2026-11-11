#!/usr/bin/env bash
# Build and publish the web app, then build and publish the Android APK.
# Usage: ./deploy/release-both.sh --approve "release notes"
# Add --allow-dirty / --allow-unpushed only when the caller explicitly authorizes it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="$ROOT/app"
GRADLE_FILE="$ROOT/app/android/app/build.gradle"
BASE_URL="${BASE_URL:-https://home.xiaokubao.space/schedule}"
APPROVE=0
ALLOW_DIRTY=0
ALLOW_UNPUSHED=0
NOTES=""

for arg in "$@"; do
  case "$arg" in
    --approve) APPROVE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    --*) printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
    *) [ -z "$NOTES" ] || { echo '更新说明只能提供一次' >&2; exit 2; }; NOTES="$arg" ;;
  esac
done

[ -n "$NOTES" ] || NOTES="日程管理版本发布"

fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# Read versions without changing source files. The normal patch suggestion is
# informational; a release must use already-committed, matching version fields.
ROOT_VERSION="$(node -p "require('./package.json').version")"
APP_VERSION="$(node -p "require('./app/package.json').version")"
ROOT_LOCK_VERSION="$(node -p "require('./package-lock.json').version")"
ROOT_LOCK_PACKAGE_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"
APP_LOCK_VERSION="$(node -p "require('./app/package-lock.json').version")"
APP_LOCK_PACKAGE_VERSION="$(node -p "require('./app/package-lock.json').packages[''].version")"
ANDROID_VERSION="$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' "$GRADLE_FILE" | head -1)"
ANDROID_CODE="$(sed -n 's/.*versionCode[[:space:]]\+\([0-9][0-9]*\).*/\1/p' "$GRADLE_FILE" | head -1)"

CURRENT="$ROOT_VERSION"
case "$CURRENT" in
  *.*.*) ;;
  *) fail "根 package.json 版本不是 x.y.z：$CURRENT" ;;
esac
PATCH_BASE="${CURRENT%.*}"
PATCH_NOW="${CURRENT##*.}"
case "$PATCH_NOW" in *[!0-9]*|'') fail "无法解析当前 patch 版本：$CURRENT" ;; esac
SUGGESTED_VERSION="$PATCH_BASE.$((PATCH_NOW + 1))"
SUGGESTED_CODE="$((ANDROID_CODE + 1))"
printf '版本建议：versionName %s -> %s；versionCode %s -> %s\n' \
  "$CURRENT" "$SUGGESTED_VERSION" "$ANDROID_CODE" "$SUGGESTED_CODE"

for version in "$APP_VERSION" "$ROOT_LOCK_VERSION" "$ROOT_LOCK_PACKAGE_VERSION" \
               "$APP_LOCK_VERSION" "$APP_LOCK_PACKAGE_VERSION" "$ANDROID_VERSION"; do
  [ "$version" = "$CURRENT" ] || fail "版本字段不一致：根版本 $CURRENT，但发现 $version。请先统一并提交版本文件。"
done
[ -n "$ANDROID_CODE" ] || fail 'build.gradle 中无法读取 versionCode'

REMOTE_MANIFEST="$(curl -fsS --noproxy '*' "${BASE_URL%/}/dl/version.json" 2>/dev/null)" \
  || fail "无法读取线上 version.json：${BASE_URL%/}/dl/version.json"
REMOTE_CODE="$(printf '%s' "$REMOTE_MANIFEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const n=JSON.parse(s).versionCode; if(Number.isInteger(n)&&n>0) process.stdout.write(String(n));}catch{}})")"
REMOTE_NAME="$(printf '%s' "$REMOTE_MANIFEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const n=JSON.parse(s).versionName; if(typeof n==='string') process.stdout.write(n);}catch{}})")"
[ -n "$REMOTE_CODE" ] || fail '线上 version.json 缺少合法 versionCode'
[ -n "$REMOTE_NAME" ] || fail '线上 version.json 缺少 versionName'

if [ "$APPROVE" = 1 ]; then
  VERSION_OK="$(node -e 'const [a,b]=process.argv.slice(1); const p=s=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(s); if(!m)process.exit(2); return m.slice(1).map(Number)}; const x=p(a),y=p(b); process.stdout.write(String(x[0]>y[0] || (x[0]===y[0] && (x[1]>y[1] || (x[1]===y[1] && x[2]>=y[2])))))' "$CURRENT" "$REMOTE_NAME")" \
    || fail "版本号格式无法比较：本地 $CURRENT / 线上 $REMOTE_NAME"
  [ "$VERSION_OK" = true ] || fail "versionName $CURRENT 低于线上版本 $REMOTE_NAME"
  [ "$ANDROID_CODE" -gt "$REMOTE_CODE" ] || fail "versionCode $ANDROID_CODE 必须高于线上 versionCode $REMOTE_CODE"
else
  printf '线上版本：versionName %s / versionCode %s\n' "$REMOTE_NAME" "$REMOTE_CODE"
  printf '建议值校验：versionName %s / versionCode 至少 %s\n' "$SUGGESTED_VERSION" "$SUGGESTED_CODE"
fi

if [ "$APPROVE" != 1 ]; then
  printf '\n未发布。确认版本字段和发布范围后，用 --approve 显式授权：\n'
  printf '  ./deploy/release-both.sh --approve "%s"\n' "$NOTES"
  exit 0
fi

# The version files and application changes must be committed/pushed before the
# release scripts run, preserving the existing provenance gate.
if [ "$ALLOW_DIRTY" = 1 ]; then DIRTY_FLAG=(--allow-dirty); else DIRTY_FLAG=(); fi
if [ "$ALLOW_UNPUSHED" = 1 ]; then UNPUSHED_FLAG=(--allow-unpushed); else UNPUSHED_FLAG=(); fi

printf '\n== 1/4 构建并发布 Web（同源 dist）\n'
bash deploy/publish-web.sh --approve "${DIRTY_FLAG[@]}" "${UNPUSHED_FLAG[@]}"

printf '\n== 2/4 构建 APK 专用前端资源（注入 API 基址）\n'
source "$ROOT/deploy/env.sh"
cd "$APP"
VITE_API_BASE="$API_BASE" "${NODE:-node}" node_modules/vite/bin/vite.js build
if ! grep -q "${API_BASE#https://}" "$ROOT/dist/assets/"index-*.js; then
  fail "APK 构建产物未包含 API 基址：$API_BASE"
fi
"${NODE:-node}" node_modules/@capacitor/cli/bin/capacitor copy android
cd "$ROOT"

printf '\n== 3/4 发布 APK（发布器内 assembleRelease）\n'
bash deploy/publish-apk.sh --approve "${DIRTY_FLAG[@]}" "${UNPUSHED_FLAG[@]}" "$NOTES"

printf '\n== 4/4 发布结果\n'
printf 'Web 与 APK 发布流程均已完成。线上功能实测与真机实测未执行；本脚本不会连接或安装设备。\n'
printf '版本：%s（versionCode %s）\n' "$CURRENT" "$ANDROID_CODE"
