#!/usr/bin/env bash
#
# Android 编译的唯一入口 —— 只负责「把工具链摆正」，不关心业务。
#
#   ./deploy/gradle.sh                       # 默认 :app:assembleDebug
#   ./deploy/gradle.sh :app:assembleRelease  # Release 包
#   ./deploy/gradle.sh :app:tasks --quiet    # 任意 gradle 任务
#
# ⚠️ **为什么要有这个脚本**（2026-10-25 卡了 40 分钟换来的）
# 在 Windows 上直接敲 gradle / ./gradlew，有三条独立的坑，每条都不报「真正的原因」：
#
#   1. `./gradlew` 会先下 gradle-8.14.3-all.zip（**230MB**）。
#      本机网络下得极慢，看起来就是「卡住不动、没有任何输出」，能卡半小时。
#      本机其实已经有解压好的发行版：~/gradle-dist/gradle-8.14.3/。
#      → 本脚本优先用这份，**永远不走 wrapper 下载**。
#
#   2. 不设 ANDROID_HOME 就报 `SDK location not found`。
#      本项目的 app/android/local.properties 是**空文件**，指望不上它。
#      → 本脚本自动探测 ~/Android 等常见位置并导出。
#
#   3. 不设 JAVA_HOME 时可能拿到系统里另一套 JDK（版本不符会在
#      compileDebugJavaWithJavac 阶段才炸，前面都正常）。
#      → 本脚本锁定 jdk-21。
#
# 这三件事以前靠人记，记漏一次就是半小时。现在固化。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/app/android"

die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. Gradle
# 优先级：显式 $GRADLE → 本地已解压的发行版（取版本号最大的）→ wrapper（会下载，最后手段）
pick_gradle() {
  if [ -n "${GRADLE:-}" ]; then
    [ -x "$GRADLE" ] || die "$GRADLE 不可执行"
    echo "$GRADLE"; return
  fi
  local best=""
  for d in "$HOME"/gradle-dist/gradle-*/bin/gradle; do
    [ -x "$d" ] || continue
    # 按路径字符串比较即可，gradle-8.9 / 8.14.3 这种命名顺序正好一致
    [[ "$d" > "$best" ]] && best="$d"
  done
  if [ -n "$best" ]; then echo "$best"; return; fi
  if [ -x "$ANDROID_DIR/gradlew" ]; then
    printf '\033[1;33m!! 本地没有解压好的 gradle 发行版，退回 wrapper（首次会下载 ~230MB）\033[0m\n' >&2
    echo "$ANDROID_DIR/gradlew"; return
  fi
  die "找不到 gradle：既没有 ~/gradle-dist/gradle-*/bin/gradle，也没有 wrapper"
}
export GRADLE_BIN="$(pick_gradle)"

# ------------------------------------------------------------ 2. Android SDK
pick_android_home() {
  local c
  # 注：${USERNAME:-} —— Linux 下 USERNAME 未定义，set -u 会直接炸（2026-10-26 合后构建挂在这行）。
  # 后面三项是 Linux 本机 toolchain 位置（见 deploy/env.sh 同口径），standalone 直接跑本脚本时也找得到。
  for c in "${ANDROID_HOME:-}" "$HOME/Android" "$HOME/AppData/Local/Android/Sdk" \
           "$HOME/.local/toolchains/android-sdk" /vol2/.toolchains/android-sdk "$HOME/android-sdk" \
           "/c/Users/${USERNAME:-}/AppData/Local/Android/Sdk" "/c/Android/Sdk"; do
    [ -n "$c" ] || continue
    [ -d "$c/platforms" ] && { echo "$c"; return; }
  done
  return 1
}
ANDROID_HOME="$(pick_android_home)" \
  || die "找不到 Android SDK（要含 platforms/ 目录）。装好 SDK 或显式 export ANDROID_HOME=..."
export ANDROID_HOME

# ------------------------------------------------------------------ 3. JDK
pick_java_home() {
  local c
  # 同上：Linux 补 toolchain 口径（见 deploy/env.sh），Windows 保持原样。
  # 注意已转义空格的路径不要再加引号 —— for c in "a\ b" 会把反斜杠当字面量。
  for c in "${JAVA_HOME:-}" "$HOME/.local/toolchains/jdk-21" /vol2/.toolchains/jdk-21 \
           /usr/lib/jvm/java-21-openjdk-amd64 \
           /c/Program\ Files/Microsoft/jdk-21* /c/Program\ Files/Java/jdk-21*; do
    [ -n "$c" ] || continue
    [ -x "$c/bin/java" ] || [ -x "$c/bin/java.exe" ] && { echo "$c"; return; }
  done
  return 1
}
if JAVA_HOME="$(pick_java_home)"; then export JAVA_HOME; else
  printf '\033[1;33m!! 没锁定 JDK，沿用系统的（版本不符会编译失败）\033[0m\n' >&2
fi

[ -f "$ANDROID_DIR/keystore.properties" ] \
  || printf '\033[1;33m!! 缺 keystore.properties —— 只能出未签名的 release\033[0m\n' >&2

echo "==> gradle      $GRADLE_BIN"
echo "==> ANDROID_HOME $ANDROID_HOME"
echo "==> JAVA_HOME    ${JAVA_HOME:-<系统默认>}"

# --------------------------------------------------------------- 4. 执行
cd "$ANDROID_DIR"
if [ "$#" -eq 0 ]; then
  set -- :app:assembleDebug
fi
exec "$GRADLE_BIN" "$@"
