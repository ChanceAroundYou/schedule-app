#!/usr/bin/env bash
#
# 构建 APK（debug）：网页资源 → APK 内置资源 → 编译。
#
#   ./deploy/build-apk.sh
#
# 产物：app/android/app/build/outputs/apk/debug/app-debug.apk
#
# ⚠️ **为什么要有这个脚本**（2026-10-14 血泪）：
# 有三件容易漏的事，漏了都不会报错，只会「界面/数据悄悄不对」：
#
#   1. `VITE_API_BASE` 不注入 → App 里接口全打到 `https://localhost`，
#      服务器返回 index.html，前端弹「服务器返回了非 JSON 内容」，
#      **整个 App 连不上后端**（但界面照常显示 localStorage 里的旧数据，
#      所以看起来「只是有点旧」，极难察觉）。这个值必须与
#      app/android/app/build.gradle 里的 UPDATE_BASE 同源。
#
#   2. 不跑 `cap copy android` → APK 里打的是
#      `app/android/app/src/main/assets/public`，那份**不会**随 vite build
#      自动更新。表现是「前端代码改了、真机上看不到」，而且 gradle
#      完全不报错（它只负责把那堆旧文件打进包）。
#
#   3. 不跑 `vite build` 就跑 gradle → 打的是上一次的 dist。
#
# 以前这三步靠人记，漏过一次（APK 里的包名和 dist 里对不上）。现在固化成一条命令。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"

# JDK / SDK / Gradle / API_BASE 全部由 .env + 平台探测决定（见 deploy/env.sh）
source "$ROOT/deploy/env.sh"

NODE="${NODE:-node}"

echo "==> 1/4 构建网页资源（VITE_API_BASE=$API_BASE）"
cd "$APP"
VITE_API_BASE="$API_BASE" "$NODE" node_modules/vite/bin/vite.js build

echo "==> 2/4 校验基址真的注进去了"
if ! grep -q "${API_BASE#https://}" "$ROOT/dist/assets/"index-*.js; then
  echo "!! dist 里找不到 $API_BASE —— 基址没注入，App 会连不上后端" >&2
  exit 1
fi
echo "    ok"

echo "==> 3/4 同步到 APK 内置资源（cap copy）"
"$NODE" node_modules/@capacitor/cli/bin/capacitor copy android

echo "==> 4/4 编译 APK"
cd "$APP/android"
JAVA_HOME="$JAVA_HOME" ANDROID_HOME="$ANDROID_HOME" "$GRADLE" assembleDebug

APK="$APP/android/app/build/outputs/apk/debug/app-debug.apk"
echo
echo "✅ 完成：$APK"
echo "   安装：adb install -r \"$APK\""
