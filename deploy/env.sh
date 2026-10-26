#!/usr/bin/env bash
#
# 构建/发布环境的统一入口 —— 被 build-apk.sh / publish-apk.sh / mobile-loop.sh `source`。
#
# 背景（2026-10-26）：以前 JDK / SDK / Gradle 的路径在脚本里写死成 Windows 的
# `C:/Users/小哭包/...`，换到 Linux 机器（fn、ubuntu）就跑不起来。现在统一走：
#
#   1. 项目根的 `.env`（**本机私有，gitignore**）—— 每台设备各自填；
#   2. `.env.template`（进库）—— 变量清单与示例，复制一份改成 `.env` 即可；
#   3. 都没写时按平台探测常见位置（Windows 的 Microsoft JDK / 家目录 Android，
#      Linux 的 /usr/lib/jvm 与常见 toolchain 目录）。
#
# 变量：
#   JAVA_HOME     JDK 21（AGP 8.13 与 capacitor 的 compileOptions 都要 21）
#   ANDROID_HOME  Android SDK（platforms;android-36 + build-tools;36.0.0）
#   GRADLE        gradle 可执行文件；不填则用仓库自带的 app/android/gradlew
#   SSH_HOST      发布目标（~/.ssh/config 别名），默认 ubuntu
#   BASE_URL      自更新清单地址，默认 https://home.xiaokubao.space/schedule
#   API_BASE      前端打包注入的接口基址，默认同 BASE_URL
#
# 只放**路径与地址**，不放密码。keystore 密码仍然只存在
# app/android/keystore.properties（已 gitignore）。

_env_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# .env 按 shell 语法读；值是带空格的路径时请加引号，例如
#   JAVA_HOME="C:/Program Files/Microsoft/jdk-21.0.12.101-hotspot"
if [ -f "$_env_root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$_env_root/.env"
  set +a
fi

# ---- JDK ----
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  for _c in \
    "$HOME"/.local/toolchains/jdk-21 \
    /vol2/.toolchains/jdk-21 \
    "$HOME"/jdk-21* \
    /usr/lib/jvm/java-21-openjdk-amd64 \
    '/c/Program Files/Microsoft/jdk-21.0.12.101-hotspot' \
    'C:/Program Files/Microsoft/jdk-21.0.12.101-hotspot'; do
    if [ -x "$_c/bin/java" ] || [ -x "$_c/bin/java.exe" ]; then JAVA_HOME="$_c"; break; fi
  done
fi
export JAVA_HOME="${JAVA_HOME:-}"

# ---- Android SDK ----
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME}/platforms" ]; then
  for _c in \
    "$HOME"/.local/toolchains/android-sdk \
    /vol2/.toolchains/android-sdk \
    "$HOME"/android-sdk \
    "$HOME"/Android \
    '/c/Users/小哭包/Android' \
    'C:/Users/小哭包/Android'; do
    if [ -d "$_c/platforms" ]; then ANDROID_HOME="$_c"; break; fi
  done
fi
export ANDROID_HOME="${ANDROID_HOME:-}"

# ---- Gradle ----
# 不填就用仓库自带的 wrapper（会按其 distributionUrl 下载，离线机器请显式指定）。
if [ -z "${GRADLE:-}" ]; then
  if [ -x "$_env_root/app/android/gradlew" ]; then
    GRADLE="$_env_root/app/android/gradlew"
  else
    GRADLE=gradle
  fi
fi

# ---- aapt（publish 读 versionCode 用；aapt 是平台相关的，别写死 .exe）----
# 优先 build-tools 里版本号最大的那个。
pick_aapt() {
  local bt="$ANDROID_HOME/build-tools" d exe
  [ -d "$bt" ] || return 1
  exe=aapt
  [ -x "$bt/$(ls "$bt" | sort -V | tail -1)/aapt.exe" ] && exe=aapt.exe
  for d in $(ls "$bt" 2>/dev/null | sort -Vr); do
    [ -x "$bt/$d/$exe" ] && { printf '%s' "$bt/$d/$exe"; return 0; }
  done
  return 1
}
AAPT="${AAPT:-$(pick_aapt || true)}"
export AAPT

SSH_HOST="${SSH_HOST:-ubuntu}"
BASE_URL="${BASE_URL:-https://home.xiaokubao.space/schedule}"
API_BASE="${API_BASE:-$BASE_URL}"
export GRADLE SSH_HOST BASE_URL API_BASE

# 给调用方一个统一的体检：缺什么就一次说清楚，别让 gradle 抛半截错误。
env_require() {
  local missing=0
  if [ ! -x "$JAVA_HOME/bin/java" ] && [ ! -x "$JAVA_HOME/bin/java.exe" ]; then
    printf '\033[1;31m!! 找不到 JDK 21：请设置 JAVA_HOME（见 .env.template）\033[0m\n' >&2
    missing=1
  fi
  if [ ! -d "$ANDROID_HOME/platforms" ]; then
    printf '\033[1;31m!! 找不到 Android SDK：请设置 ANDROID_HOME（见 .env.template）\033[0m\n' >&2
    missing=1
  fi
  if [ -z "$AAPT" ] || [ ! -x "$AAPT" ]; then
    printf '\033[1;31m!! 找不到 aapt（Android SDK build-tools 没装全？）\033[0m\n' >&2
    missing=1
  fi
  return "$missing"
}
