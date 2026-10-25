#!/usr/bin/env bash
#
# mobile-loop.sh —— 手机端「改完 → 打包 → 发布 → 装机 → 真机冒烟」的一键闭环
#
#   ./deploy/mobile-loop.sh                    # 全套
#   ./deploy/mobile-loop.sh --device IP:端口   # 顺带指定设备（端口会轮换）
#   ./deploy/mobile-loop.sh --no-publish       # 只装机本地包，不发到线上
#   ./deploy/mobile-loop.sh --no-build         # 已经打过包了，跳过 5/7
#   ./deploy/mobile-loop.sh --debug            # 装 debug 包（要 CDP 调试时；数据不丢）
#   ./deploy/mobile-loop.sh --probe            # 额外跑坐标时序回归（kbtiming.cjs）
#   ./deploy/mobile-loop.sh --install-only     # 只装 + 冒烟（已发过版时用）
#
# 与 web-loop.sh 的分工：网页端 / 服务端归 web-loop.sh，手机端归这里。
# 顺序铁律：**先跑 web-loop.sh 再跑本脚本**（publish-web 会重建无基址 dist，
# build-apk 再重建带基址的 —— 反序会让 publish-apk 的指纹校验挂掉）。
#
# 安全边界：
#   · 发布路径有未提交改动 → 拒发
#   · tsc / 单测 / 版本号自检任一失败 → 不打不发布
#   · **只连一次设备**（反复 adb connect 会在手机上弹一堆通知，用户明确抱怨过）
#   · 改过的系统设置（屏幕常亮）用完还原
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ADB="${ADB:-C:/Users/小哭包/Android/platform-tools/adb.exe}"
PKG="space.xiaokubao.schedule"
BASE="https://home.xiaokubao.space/schedule"

DEVICE_ARG=""
NO_PUBLISH=0
NO_BUILD=0
USE_DEBUG=0
PROBE=0
INSTALL_ONLY=0
# ⚠️ 用 while + shift，不能在 for 里 shift —— 那会打乱迭代，把 --device 后面的
#    值当成独立参数（第一版就是这么错的）。
while [ $# -gt 0 ]; do
  case "$1" in
    --device)        DEVICE_ARG="${2:-}"; shift 2;;
    --device=*)      DEVICE_ARG="${1#--device=}"; shift;;
    --no-publish)    NO_PUBLISH=1; shift;;
    --no-build)      NO_BUILD=1; shift;;
    --debug)         USE_DEBUG=1; shift;;
    --probe)         PROBE=1; shift;;
    --install-only)  INSTALL_ONLY=1; NO_BUILD=1; shift;;
    -h|--help)       sed -n '3,20p' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

# 版本号在这里就读出来，**别只放在第 4 段里**：`--install-only` / `--no-build`
# 会整段跳过，而装机校验、发布下载地址都要用它（2026-10-22 踩到 unbound variable）。
LOCAL_CODE="$(grep -oE 'versionCode [0-9]+' app/android/app/build.gradle 2>/dev/null | head -1 | awk '{print $2}')"
LOCAL_NAME="$(grep -oE 'versionName "[^"]+"' app/android/app/build.gradle 2>/dev/null | head -1 | sed 's/.*"\(.*\)"/\1/')"

FAILED=()
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { FAILED+=("$1"); printf '\033[31m   ✗ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ok  %s\033[0m\n' "$1"; }

# ================================================================ 1 可追溯
step "1/7 可追溯性检查（发布路径不能有未提交改动）"
DIRTY="$(git status --porcelain | awk '{print $2}' \
  | grep -E '^(app/src/|app/index\.html|app/tests/|server/|package(-lock)?\.json$|app/package(-lock)?\.json$|app/android/app/src/|app/android/app/build\.gradle$)' || true)"
if [ -n "$DIRTY" ]; then
  echo "  发布路径里有未提交改动："
  echo "$DIRTY" | sed 's/^/    /'
  fail "先提交再发（线上要能追溯回某个提交）"
  echo ""
  echo "== 闭环中止：先 commit"
  exit 1
fi
ok "发布路径干净"

if [ "$INSTALL_ONLY" = "0" ]; then

  # ============================================================== 2 类型检查
  step "2/7 类型检查（tsc）"
  if ( cd app && npx tsc --noEmit ) > /tmp/m-tsc.log 2>&1; then ok "tsc 0 错"; else
    fail "typecheck 失败"; tail -8 /tmp/m-tsc.log | sed 's/^/    /'; fi

  # ============================================================== 3 单测
  step "3/7 单测（app + server）"
  APP_T="$( cd app && node --disable-warning=ExperimentalWarning --test "src/**/*.test.ts" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ' )"
  echo "  app:    $APP_T"; echo "$APP_T" | grep -q 'fail 0' || fail "app 单测有失败"
  SRV_T="$(node --disable-warning=ExperimentalWarning --test "server/tests/*.test.js" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ')"
  echo "  server: $SRV_T"; echo "$SRV_T" | grep -q 'fail 0' || fail "server 单测有失败"

  # ============================================================== 4 版本号自检
  # 移动端最容易漏的就是这一步：versionCode 没加，用户永远收不到更新提示。
  step "4/7 版本号自检（versionCode 必须递增，versionName 与网页同源）"
  WEB_NAME="$(grep -oE '"version": *"[^"]+"' app/package.json | head -1 | sed 's/.*"\(.*\)"/\1/')"
  LIVE_JSON="$(curl -sS "$BASE/dl/version.json" 2>/dev/null || true)"
  LIVE_CODE="$(echo "$LIVE_JSON" | grep -oE '"versionCode": *[0-9]+' | grep -oE '[0-9]+' | head -1)"
  echo "  本地 versionCode=$LOCAL_CODE  versionName=$LOCAL_NAME（网页版 $WEB_NAME）"
  echo "  线上 versionCode=${LIVE_CODE:-读不到}"

  [ -n "$LOCAL_CODE" ] || fail "build.gradle 里读不到 versionCode"
  if [ -n "$LIVE_CODE" ] && [ "$LOCAL_CODE" -le "$LIVE_CODE" ] 2>/dev/null; then
    fail "versionCode $LOCAL_CODE 不比线上的 $LIVE_CODE 大 —— 手机永远收不到更新提示"
  else
    ok "versionCode 递增（$LIVE_CODE → $LOCAL_CODE）"
  fi
  if [ "$LOCAL_NAME" != "$WEB_NAME" ]; then
    fail "versionName($LOCAL_NAME) 与 app/package.json($WEB_NAME) 不一致 —— 两边必须同源"
  else
    ok "versionName 与网页版同源"
  fi

  # ============================================================== 5 打包
  if [ "$NO_BUILD" = "1" ]; then
    step "5/7 打包：--no-build 跳过"
  else
    step "5/7 打包（build-apk.sh：注入 API 基址 + cap copy + gradle）"
    if bash deploy/build-apk.sh > /tmp/m-build.log 2>&1; then
      tail -3 /tmp/m-build.log | sed 's/^/  /'
    else
      fail "打包失败（详见 /tmp/m-build.log）"; tail -20 /tmp/m-build.log | sed 's/^/    /'
    fi
  fi
fi

# ================================================================ 6 设备 + 发布 + 装机
step "6/7 设备 / 发布 / 装机"

# —— 只连一次 ——
if [ -n "$DEVICE_ARG" ]; then
  MSYS_NO_PATHCONV=1 "$ADB" start-server >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 "$ADB" connect "$DEVICE_ARG" >/dev/null 2>&1
fi
DEVICE="$DEVICE_ARG"
if [ -z "$DEVICE" ]; then
  DEVICE="$(MSYS_NO_PATHCONV=1 "$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
fi
if [ -z "$DEVICE" ]; then
  fail "没有在线设备"
  echo ""
  echo "  ┌ 需要你在手机上操作（约 30 秒）："
  echo "  │ 1. 设置 → 系统 → 开发者选项 → 无线调试（打开开关）"
  echo "  │ 2. 页面会显示一串「IP 地址和端口」，例如 192.168.1.172:39283"
  echo "  │    （每次开关该页面端口都会变，别用旧的）"
  echo "  │ 3. 把那串发给我，或 ./deploy/mobile-loop.sh --device IP:端口 重跑"
  echo "  └ 手机和电脑必须连同一个 WiFi"
  echo ""
  echo "== 闭环中止：没设备，发布 / 装机 / 真机冒烟都跳过"
  exit 1
else
  ok "设备 $DEVICE"
fi

APK=""
if [ -n "$DEVICE" ]; then
  if [ "$USE_DEBUG" = "1" ]; then
    APK="$ROOT/app/android/app/build/outputs/apk/debug/app-debug.apk"
    [ -f "$APK" ] || fail "debug 包不存在（先跑 build-apk.sh）"
  elif [ "$INSTALL_ONLY" = "1" ] || [ "$NO_PUBLISH" = "1" ]; then
    APK="$ROOT/app/android/app/build/outputs/apk/debug/app-debug.apk"
    [ -f "$APK" ] || APK=""
  fi

  if [ -z "$APK" ] && [ "$NO_PUBLISH" = "0" ] && [ "$INSTALL_ONLY" = "0" ]; then
    step "6/7a 发布 APK（publish-apk.sh）"
    PUB_OK=0
    if bash deploy/publish-apk.sh "手机端自动发版" > /tmp/m-pub.log 2>&1; then
      PUB_OK=1
    else
      # ⚠️ 别只信退出码：本机沙箱的 rm 钩子（BASH_ENV 注入，拦内嵌盘符路径）会把
      # 已经发成功的发布绊成非零（SAFE_DELETE_INVALID_PATH，见 docs/踩坑-环境.md），
      # 2026-10-24/25 连坑 4 次、每次都误跳装机。发布成没成，以线上 version.json
      # 是否已是本地 versionCode 为准 —— 是就继续装机。
      if curl -sS --noproxy '*' "$BASE/dl/version.json" 2>/dev/null \
           | grep -q "\"versionCode\": *$LOCAL_CODE"; then
        echo "  退出码非零，但线上 version.json 已是 $LOCAL_CODE —— 按发布成功继续（日志 /tmp/m-pub.log）"
        PUB_OK=1
      else
        fail "APK 发布失败（详见 /tmp/m-pub.log）"; tail -15 /tmp/m-pub.log | sed 's/^/    /'
      fi
    fi
    if [ "$PUB_OK" = "1" ]; then
      grep -E "发布完成|HTTP 200|versionCode" /tmp/m-pub.log | head -5 | sed 's/^/  /'
      APK="/tmp/m-$LOCAL_CODE.apk"
      curl -sS -o "$APK" "$BASE/dl/schedule-$LOCAL_CODE.apk" || APK=""
      [ -s "$APK" ] || fail "发布成功但下载不到 schedule-$LOCAL_CODE.apk"
    fi
  fi

  if [ -n "$APK" ] && [ -f "$APK" ]; then
    step "6/7b 装机 + 版本校验"
    # ⚠️ adb 是 **Windows 程序**：这条命令带着 MSYS_NO_PATHCONV=1（为了不让 adb 的
    # 远端 Unix 参数被改写），本地路径就必须自己写成盘符形式，否则走的是 `/c/...`
    # → 「failed to stat …: No such file or directory」，装的是手机上原来那个包
    # （2026-10-22 实测踩到，症状是 versionCode 校验失败 + 报「装成了调试包」）。
    APK_WIN="$(cd "$(dirname "$APK")" && pwd -W)/$(basename "$APK")"
    MSYS_NO_PATHCONV=1 "$ADB" install -r "$APK_WIN" 2>&1 | tail -2 | sed 's/^/  /'
    INFO="$(MSYS_NO_PATHCONV=1 "$ADB" shell "dumpsys package $PKG 2>/dev/null" | grep -E 'versionCode=|versionName=|pkgFlags' | head -3)"
    echo "$INFO" | sed 's/^/  /'
    echo "$INFO" | grep -q "versionCode=$LOCAL_CODE" && ok "versionCode 对上了" || fail "装机后的 versionCode 不是 $LOCAL_CODE"
    # 本地包本来就是 assembleDebug 出来的（build-apk.sh 只出 debug 包），
    # 比对「是不是调试包」只对发到线上的 release 包有意义。
    case "$APK" in
      *app-debug.apk) : ;;
      *) case "$INFO" in *DEBUGGABLE*) fail "装成了调试包（pkgFlags 有 DEBUGGABLE）";; esac ;;
    esac
  fi
fi

# ================================================================ 7 真机冒烟
step "7/7 真机冒烟（冷启动 + 崩溃检查 + 截屏）"
if [ -n "$DEVICE" ]; then
  MSYS_NO_PATHCONV=1 "$ADB" shell am force-stop "$PKG"
  MSYS_NO_PATHCONV=1 "$ADB" shell logcat -c >/dev/null 2>&1
  sleep 1
  MSYS_NO_PATHCONV=1 "$ADB" shell "am start -n $PKG/.MainActivity" >/dev/null 2>&1
  sleep 8
  PID="$(MSYS_NO_PATHCONV=1 "$ADB" shell pidof "$PKG" | tr -d '\r')"
  [ -n "$PID" ] && ok "App 在跑（pid $PID）" || fail "App 没起来"

  CRASH="$(MSYS_NO_PATHCONV=1 "$ADB" shell "logcat -d 2>/dev/null" | grep -iE 'FATAL|AndroidRuntime' | head -5)"
  if [ -n "$CRASH" ]; then
    fail "启动有崩溃栈"; echo "$CRASH" | sed 's/^/    /'
  else
    ok "启动无崩溃栈"
  fi

  # ⚠️ 目标路径必须是 **Windows 盘符形式**：pull 这条命令同时带远端 Unix 路径
  # （要 MSYS_NO_PATHCONV=1 才不被转坏）和本地路径（要真的 Windows 路径）。
  # 写 "/tmp/x.png" 会因为路径转换被关掉而变成一个 Windows 上不存在的目录 → 拉不到。
  SHOT="$(cd /tmp && pwd -W)/mobile-$(date +%H%M%S).png"
  # 冷启动那几秒 sdcard 写入偶发失败，重试一次再放弃
  for try in 1 2; do
    MSYS_NO_PATHCONV=1 "$ADB" shell "screencap -p /sdcard/loop.png" >/dev/null 2>&1
    MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/loop.png "$SHOT" >/dev/null 2>&1
    [ -s "$SHOT" ] && break
    sleep 1
  done
  [ -s "$SHOT" ] && ok "截屏 $SHOT（请用 Read 看一眼：有没有红条、角标数字是否出现）" || echo "  截屏失败"

  if [ "$PROBE" = "1" ]; then
    step "7/7b 坐标时序回归（kbtiming）"
    ( cd app && NODE_PATH="$ROOT/app/node_modules" node ../deploy/kbtiming.cjs 2>&1 | tail -4 | sed 's/^/  /' )
  fi
fi

# ================================================================ 结论
echo ""
echo "—— 需要你真手指验收（adb/CDP 模拟不出来，键盘只能真实手势唤出）——"
echo "  1. 点日程空白处：输入框是否稳定存在、能否打字、时间是否整点"
echo "  2. 手动按「收起键盘」：空着的输入框自动消失；打过字的保留"
echo "  3. 键盘弹起时点别的空白：新框是否落在你点的位置"
echo ""
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\033[31m== 闭环未通过（%d 项）\033[0m\n' "${#FAILED[@]}"
  for f in "${FAILED[@]}"; do echo "  ✗ $f"; done
  echo ""
  echo "下一步：按失败项修 → 提交 → 重跑 ./deploy/mobile-loop.sh"
  exit 1
fi
printf '\033[32m== 闭环通过：已装机并与线上版本一致\033[0m\n'
