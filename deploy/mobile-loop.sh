#!/usr/bin/env bash
#
# mobile-loop.sh —— 手机端「改完 → 打包 → 发布 → 装机 → 只读状态检查」的一键闭环
#
#   ./deploy/mobile-loop.sh                    # 全套，但发布默认 dry-run（不写生产）
#   ./deploy/mobile-loop.sh --approve          # 显式授权后才把 --approve 透传给 publish-apk.sh 真正发版
#   ./deploy/mobile-loop.sh --device IP:端口   # 顺带指定设备（端口会轮换）
#   ./deploy/mobile-loop.sh --no-publish       # 只装机本地包，不发到线上（本地测试，不代表线上一致）
#   ./deploy/mobile-loop.sh --no-build         # 已经打过包了，跳过 5/7
#   ./deploy/mobile-loop.sh --debug            # 装 debug 包（要 CDP 调试时；数据不丢）
#   ./deploy/mobile-loop.sh --probe            # 额外跑坐标时序回归（kbtiming.cjs；诊断项，无 PASS marker/断言 rc 时未达成计入 FAILED）
#   ./deploy/mobile-loop.sh --install-only     # 只装 + 冒烟（已发过版时用）
#
# 与 web-loop.sh 的分工：网页端 / 服务端归 web-loop.sh，手机端归这里。
# 顺序铁律：**先跑 web-loop.sh 再跑本脚本**（publish-web 会重建无基址 dist，
# build-apk 再重建带基址的 —— 反序会让 publish-apk 的指纹校验挂掉）。
#
# 安全边界：
#   · 发布路径有未提交改动 → 拒发；git status / connect / devices 等命令失败一律置 FAILED
#   · tsc / 单测 / 版本号自检任一失败 → 不打不发布
#   · **发布默认 dry-run**：未给 --approve 时 publish-apk.sh 只打摘要、不写生产。
#     AGENTS.md 第 11 条：不替用户加 --approve。真实发布只在调用方（用户 / 主管
#     在已授权主流程中）**显式**传 --approve 时发生；本脚本绝不默认替它补，
#     也不把 dry-run 的 exit 1 当成线上发布失败去查 version.json 后继续装机。
#     这次 worker 不真实执行发布，只做纯本地验证。
#   · **dry-run 判定只看 publish-apk.sh 的专用退出码 20（round7，替换 round5 FD 通道）**：
#     mobile-loop 以**同步直接子进程**调用 `publish-apk.sh --machine-dry-run`，
#     只有它返回 20（= preflight/SUMMARY 已就绪的无授权 dry-run）才算 EXPECTED；
#     其它任何退出码（preflight/env 错误 exit 1、超时 124/137、被 kill 等）一律
#     ABNORMAL → fail-closed 停止、绝不装机。退出状态由内核在 wait 时交给父进程，
#     同 UID 的另一进程无法抢写，故不再需要 nonce / 匿名 pipe / 结果文件；
#     也**不读 stdout/stderr 文本**下结论（摘要只作展示）。同步调用有 timeout 上限：
#     只给**直接启动的发布子命令**设时限，信号作用范围以本机 timeout 工具实际行为
#     为准（默认向它启动的命令发 SIGTERM），**不保证**能终止所有子进程 / 脱离进程组
#     的后代，也不声称杀「全部进程组」；没有 coproc/第二次 read 等 EOF。
#     **runtime 缺 timeout 即拒绝运行**：probe 判 ABNORMAL:timeout_missing（不无界
#     调用、不返回 20），上层 fail-closed；目标 Windows/Git Bash 真机未验证前不假设
#     timeout 一定存在（worker 测试环境实测 GNU coreutils 8.32 /usr/bin/timeout 可用）。
#   · **不声称同 UID 隔离 / 不伪造 security**：早先 ml_fd_channel_guard 只测 FD9
#     却用 FD3，且匿名 pipe 无法一般性证明同 UID 进程不可伪造，故整条结果通道已
#     删除；任何不确定都判 ABNORMAL 并中止、不装机。真实发布仍走另一条不依赖本
#     判定的路径：调用方显式 --approve 触发真实发布（本脚本绝不自动补 --approve）。
#   · **只连一次设备**（反复 adb connect 会在手机上弹一堆通知，用户明确抱怨过）
#   · 改过的系统设置（屏幕常亮）用完还原
#   · **冒烟降级为只读状态检查**：不 force-stop、不 logcat -c、不 am start；
#     这不等于「完整冷启动冒烟」，摘要与最终说明都明确标注，绝不声称等价。
#   · **设备截图为可选项、非验收项**：失败不置 FAILED，也从不据此宣称「完整通过」。
#   · **本地 debug vs 线上发布**：仅 --approve 且真正发布并下载线上 release 包才算
#     online-release；其余（默认 dry-run / --no-publish / --install-only / --debug）都是
#     本地测试，绝不宣称「与线上一致 / 线上发布」。
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
# 发布授权（2026-11-09，Reviewer B）：默认 0 = 不发布。**绝不**自动给
# publish-apk.sh 加 --approve；只有调用方显式传 --approve 才置 1。
APPROVE=0
# ⚠️ 用 while + shift，不能在 for 里 shift —— 那会打乱迭代，把 --device 后面的
#    值当成独立参数（第一版就是这么错的）。
while [ $# -gt 0 ]; do
  case "$1" in
    --approve)       APPROVE=1; shift;;
    --device)        DEVICE_ARG="${2:-}"; shift 2;;
    --device=*)      DEVICE_ARG="${1#--device=}"; shift;;
    --no-publish)    NO_PUBLISH=1; shift;;
    --no-build)      NO_BUILD=1; shift;;
    --debug)         USE_DEBUG=1; shift;;
    --probe)         PROBE=1; shift;;
    --install-only)  INSTALL_ONLY=1; NO_BUILD=1; shift;;
    -h|--help)       sed -n '3,12p' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

# 版本号在这里就读出来，**别只放在第 4 段里**：`--install-only` / `--no-build`
# 会整段跳过，而装机校验、发布下载地址都要用它（2026-10-22 踩到 unbound variable）。
LOCAL_CODE="$(grep -oE 'versionCode [0-9]+' app/android/app/build.gradle 2>/dev/null | head -1 | awk '{print $2}')"
LOCAL_NAME="$(grep -oE 'versionName "[^"]+"' app/android/app/build.gradle 2>/dev/null | head -1 | sed 's/.*"\(.*\)"/\1/')"

# —— 验收状态：拆成独立状态，只有所需验收项**实际成功**才可能打印闭环通过。
#    INSTALLED 只在装机 + versionCode 校验成功后置 1；VERSION_OK 单独记录版本校验；
#    CRASH_CHECK 只在崩溃只读检查证据充分且 clean 后置 1；SMOKE_RAN 只在 App 在跑
#    且只读状态检查执行后置 1。任一为 0 / FAILED>0 → 最终一律 FAIL，绝不误报。
FAILED=0
FAIL_ITEMS=()
INSTALLED=0
VERSION_OK=0
CRASH_CHECK=0
SMOKE_RAN=0
# 发布模式：local-debug（默认，含 --no-publish/--install-only/默认 dry-run）或
# online-release（仅 --approve 真正发版并装线上下载包）。见结论段的 MODE_NOTE。
PUB_MODE="local-debug"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); FAIL_ITEMS+=("$1"); printf '\033[31m   ✗ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ok  %s\033[0m\n' "$1"; }

# 证据目录（提前建好，供第 1/4/6/7 段捕获命令真实 rc / 原始输出）。私有化，避免被改。
ML_EVIDENCE="/tmp/mobile-loop-evidence"
mkdir -p "$ML_EVIDENCE" 2>/dev/null
chmod 700 "$ML_EVIDENCE" 2>/dev/null

# ===========================================================================
# 纯判定 / 采集辅助函数（无 adb / SSH / git / 网络副作用；node 仅做确定性时间计算）
# —— 供本地 mock 测试用抽取脚本 source 后直接调用「生产同一函数」。
# 本段自包含：常量与互相调用的函数都在段内定义。主流程只负责把 dumpsys / 时钟 /
# logcat 与 publish 命令真实 rc 喂进来，据结论 fail-closed。
# ==== BEGIN ML PURE HELPERS ====
ML_LOOKBACK_SEC=10          # logcat 回溯窗口（秒），窗口起点向前 10 秒
ML_DRIFT_MAX_SEC=5          # 本机↔设备 epoch 允许偏差（秒），纳入采样区间
# dry-run 就绪专用退出码（publish-apk.sh --machine-dry-run 返回它）与同步调用上限（秒）。
ML_DRYRUN_READY_RC=20
ML_DRYRUN_TIMEOUT_SEC=90

# dry-run 就绪判定（round7）：**只看 publish-apk.sh 同步直接子进程的真实退出码**。
# 不读 stdout/stderr 文本、不读任何文件/FD —— 退出状态由内核在 wait 时交给父进程，
# 同 UID 的另一进程无法抢写；任何伪造的 stdout 状态行都不参与。
# 只有专用码 ML_DRYRUN_READY_RC(20) 才是 EXPECTED_DRYRUN；其余（preflight/env 错误 1、
# timeout 124/137、被 kill、空/非数字）一律 ABNORMAL → 上层 fail-closed。
# 参数: <真实退出码>
# 输出: EXPECTED_DRYRUN / ABNORMAL:<reason>
ml_assess_dryrun_rc() {
  local rc="$1"
  case "$rc" in
    ''|*[!0-9]*) printf 'ABNORMAL:bad_rc=%s\n' "${rc:-<空>}"; return;;
  esac
  [ "$rc" = "$ML_DRYRUN_READY_RC" ] \
    || { printf 'ABNORMAL:not_ready_rc=%s\n' "$rc"; return; }
  printf 'EXPECTED_DRYRUN\n'
}

# 确定性 epoch（ms）：项目已依赖 node、上方 tsc/单测段已定位 node，优先用它；
# 退而求其次用 PowerShell 的 UnixTimeMilliseconds；都不可用返回空 → 上层 fail-closed。
# **绝不退回 GNU `date -d`**（Windows Git Bash 的 date -d 解析不可假设）。
ml_epoch_ms() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -NonInteractive -Command \
      '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()' 2>/dev/null | tr -d '\r\n'
  else
    printf ''
  fi
}

# 本机时钟（round4-B）：一次 node 调用同时给出 UTC epoch 毫秒与本机 TZ 偏移
# （+HHMM / -HHMM）。epoch 是 UTC 绝对时刻，host/device 用同一把尺子，不假设本地时区。
# 输出 '<epoch_ms> <+HHMM>'；node 不可用返回空 → 上层判 UNTRUSTED，绝不报 clean。
ml_host_clock() {
  if ! command -v node >/dev/null 2>&1; then printf '\n'; return 1; fi
  node -e '
    const o = -new Date().getTimezoneOffset();     // 本机相对 UTC 的分钟偏移（含 DST）
    const s = o >= 0 ? "+" : "-";
    const a = Math.abs(o);
    const tz = s + String(Math.floor(a / 60)).padStart(2, "0") + String(a % 60).padStart(2, "0");
    process.stdout.write(String(Date.now()) + " " + tz + "\n");
  ' 2>/dev/null
}

# 从任意行里抽取并归一化 component 为 'pkg/full.Activity'。兼容（保留已验证字段格式）：
#   ComponentInfo{pkg/.Activity} / ComponentInfo{pkg/pkg.Activity}
#   pkg/.Activity              / pkg/pkg.Activity
#   ActivityRecord{... pkg/.Activity ...}（window 的 mFocusedApp 常见）
#   Window{... pkg/pkg.Activity ...}    （window 的 mCurrentFocus 常见）
# 相对名 '.Foo' 补成 'pkg.Foo'，与全名写法去重后是同一个 component。
ml_extract_components() {
  grep -oE '[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+/[.$A-Za-z0-9_]+' \
    | awk -F/ '{ a=$2; if (substr(a,1,1)==".") a=$1 a; print $1 "/" a }'
}

# 前台判定（round4-A）：Activity 与 window 焦点**分别唯一**且 **component 级一致**，
# 绝不只比较包名。**严格按记录解析**：字段名锚定行首（只认 resumed/top Activity 与
# mCurrentFocus/mFocusedApp），window 两个焦点字段**分别**解析；不用 currentFocus 当
# Activity，也不把宽泛文本里的任意 component 当成前台证据。
# 参数: <目标包名> <activity dumpsys rc> <window dumpsys rc> <activity 文本> <window 文本>
# 输出: ALLOW:<component> / BLOCK:<reason>
# 只有「两条命令都成功 + Activity 侧解析出且仅解析出一个 resumed/top component
# + window 侧两个焦点字段各自唯一、并集恰好一个 component 且与之 **component 完全相等**
# + 该包不是目标包」才 ALLOW；其余全部 fail-closed：
#   · 命令失败 / 空 / 未知格式 / 格式不全 / 多个 Activity 候选
#   · 焦点缺失 / 未知格式 / 多窗口多个组件 / 目标包前台
#   · 同包不同 Activity（component_mismatch）/ 不同包（focus_conflict）一律拒绝
# 注意 mCurrentFocus 与 mFocusedApp 可能正常指向同一包不同子窗口；只要二者解析出的
# component 不一致，就无法证明组件级一致 → BLOCK:focus_multiple（保守 fail-closed）。
ml_front_decision() {
  local pkg="$1" arc="$2" wrc="$3" adump="$4" wdump="$5"
  local act_lines act_comp act_n
  local wcf_lines wfa_lines wcf_comp wfa_comp wcf_n wfa_n focus_comp focus_n
  local apkg fpkg cpkg
  # adb 真实 rc 由调用层 ml_capture_adb 捕获（tr 只清洗文本、不参与 rc），任一失败 fail-closed
  [ "$arc" = "0" ] || { printf 'BLOCK:command_failed\n'; return; }
  [ "$wrc" = "0" ] || { printf 'BLOCK:command_failed\n'; return; }
  [ -n "$(printf '%s' "$adump" | tr -d '[:space:]')" ] || { printf 'BLOCK:empty\n'; return; }
  [ -n "$(printf '%s' "$wdump" | tr -d '[:space:]')" ] || { printf 'BLOCK:empty\n'; return; }

  # —— Activity 侧：只认行首锚定的 resumed/top 字段（不含 currentFocus / focusedApp）——
  act_lines="$(printf '%s\n' "$adump" \
    | grep -iE '^[[:space:]]*(topResumedActivity|mResumedActivity|ResumedActivity)[[:space:]]*[:=]')"
  [ -n "$act_lines" ] || { printf 'BLOCK:unknown_format\n'; return; }
  act_comp="$(printf '%s\n' "$act_lines" | ml_extract_components | sort -u)"
  [ -n "$act_comp" ] || { printf 'BLOCK:unknown_format\n'; return; }
  act_n="$(printf '%s\n' "$act_comp" | wc -l | tr -d ' ')"
  [ "$act_n" = "1" ] || { printf 'BLOCK:multiple_candidates\n'; return; }

  # —— window 侧：mCurrentFocus 与 mFocusedApp **分别按记录解析**（交叉核验）——
  wcf_lines="$(printf '%s\n' "$wdump" \
    | grep -iE '^[[:space:]]*mCurrentFocus[[:space:]]*[:=]')"
  wfa_lines="$(printf '%s\n' "$wdump" \
    | grep -iE '^[[:space:]]*mFocusedApp[[:space:]]*[:=]')"
  # 两个焦点字段都不存在 → 缺失
  [ -n "$wcf_lines" ] || [ -n "$wfa_lines" ] || { printf 'BLOCK:focus_missing\n'; return; }
  wcf_comp=""; wfa_comp=""
  [ -z "$wcf_lines" ] || wcf_comp="$(printf '%s\n' "$wcf_lines" | ml_extract_components | sort -u)"
  [ -z "$wfa_lines" ] || wfa_comp="$(printf '%s\n' "$wfa_lines" | ml_extract_components | sort -u)"
  # 每个出现的字段：0 个 component = 未知/格式不全；>1 个 = 该记录宽泛歧义，全部拒绝
  if [ -n "$wcf_lines" ]; then
    [ -n "$wcf_comp" ] || { printf 'BLOCK:focus_unknown_format\n'; return; }
    wcf_n="$(printf '%s\n' "$wcf_comp" | wc -l | tr -d ' ')"; [ "$wcf_n" = "1" ] || { printf 'BLOCK:focus_multiple\n'; return; }
  fi
  if [ -n "$wfa_lines" ]; then
    [ -n "$wfa_comp" ] || { printf 'BLOCK:focus_unknown_format\n'; return; }
    wfa_n="$(printf '%s\n' "$wfa_comp" | wc -l | tr -d ' ')"; [ "$wfa_n" = "1" ] || { printf 'BLOCK:focus_multiple\n'; return; }
  fi
  # 合并两个字段：并集必须恰好 1 个 component（多窗口 / 多个组件 → 无法证明 → 拒绝）。
  # mCurrentFocus 与 mFocusedApp 指向同包不同子窗口时也落在这里，保守 fail-closed。
  focus_comp="$(printf '%s\n%s\n' "$wcf_comp" "$wfa_comp" | sed '/^$/d' | sort -u)"
  focus_n="$(printf '%s\n' "$focus_comp" | wc -l | tr -d ' ')"
  [ "$focus_n" = "1" ] || { printf 'BLOCK:focus_multiple\n'; return; }

  # —— component 级一致（不可只比较包名）——
  # act_comp / focus_comp 均为 'pkg/full.Activity'，必须**完全相等**。
  if [ "$act_comp" != "$focus_comp" ]; then
    apkg="${act_comp%%/*}"; fpkg="${focus_comp%%/*}"
    if [ "$apkg" != "$fpkg" ]; then
      printf 'BLOCK:focus_conflict\n'          # 不同包：交叉核验冲突
    else
      printf 'BLOCK:component_mismatch\n'      # 同包不同 Activity：组件不一致，拒绝安装
    fi
    return
  fi
  cpkg="${act_comp%%/*}"
  [ "$cpkg" != "$pkg" ] || { printf 'BLOCK:target_foreground\n'; return; }
  printf 'ALLOW:%s\n' "$act_comp"
}

# 时钟闸门（round4-B）：显式同一时区 = **UTC epoch**。
#   · 本机：ml_host_clock 给 UTC epoch(ms) + 本机 TZ 偏移(+HHMM)；
#   · 设备：adb shell 'date +%s %z' 给 UTC epoch(秒) + 设备 TZ 偏移(+HHMM)；
#   · epoch 是 UTC 绝对时刻，所有时间比较都在 epoch 数值上做，**与本地时区无关**；
#     logcat 也用 `logcat -v epoch`（时间戳为 UTC epoch），彻底绕开「logcat 按设备时区 /
#     宿主 Node 按宿主时区」的错配（这是 finding B 认可的「更可靠 UTC epoch 过滤」分支）。
#   · 但 finding B 同时要求「显式使用同一时区」+「mock 证明不同 TZ 无法通过」：故额外
#     把 host TZ（node getTimezoneOffset）与 device TZ（date +%z）作**显式一致性门控**，
#     不一致即 UNTRUSTED。它在纯 epoch 设计里是冗余的保守层（epoch 本不依赖 TZ），
#     目的是让「不同 TZ」有确定、可测的 fail-closed 落点，并满足「无设备不假称已验证」。
#     TZ 一致只作门槛，绝不参与任何时间格式化或窗口换算。
# ⚠️ 本机无真机，**不宣称 `date +%z` / `logcat -v epoch` 已在真实设备验证**：
#    设备 TZ 读不到 / 格式不对 / 与本机不一致 → UNTRUSTED（不同 TZ 无法通过）；
#    logcat 输出解析不出 epoch 时间戳 → INSUFFICIENT。两者都 fail-closed，绝不据不确定
#    窗口判 clean。
# 参数: <host_before_ms> <host_after_ms> <host_tz> <dev_epoch_raw> <dev_tz_raw>
#       <device_adb_rc> <drift_max_sec>
# 输出: OK:<since_epoch_sec>:<upper_epoch_sec> / UNTRUSTED:<reason>
ml_clock_gate() {
  local before="$1" after="$2" host_tz="$3" draw="$4" dev_tz="$5" drc="$6" drift_max="$7"
  local dev_ms dev_sec drift_ms since_sec upper_sec
  case "$before" in ''|*[!0-9]*) printf 'UNTRUSTED:host_epoch_not_numeric\n'; return;; esac
  case "$after"  in ''|*[!0-9]*) printf 'UNTRUSTED:host_epoch_not_numeric\n'; return;; esac
  [ "$after" -ge "$before" ] || { printf 'UNTRUSTED:host_epoch_order\n'; return; }
  # 本机 TZ 显式已知
  printf '%s' "$host_tz" | grep -qE '^[+-][0-9]{4}$' \
    || { printf 'UNTRUSTED:host_tz_unknown\n'; return; }
  # 设备 adb 命令失败 / 输出为空 → 证据不足，fail-closed
  [ "$drc" = "0" ] || { printf 'UNTRUSTED:device_epoch_command_failed\n'; return; }
  case "$draw" in ''|*[!0-9]*) printf 'UNTRUSTED:device_epoch_not_numeric\n'; return;; esac
  # 设备 TZ 显式已知（格式 '+0800' / '-0500'）；不支持 %z 会输出别的 → UNTRUSTED
  printf '%s' "$dev_tz" | grep -qE '^[+-][0-9]{4}$' \
    || { printf 'UNTRUSTED:device_tz_unknown\n'; return; }
  # 显式同一时区：host 与 device 偏移必须一致；不同 TZ 一律 UNTRUSTED（无法通过 → 不报 clean）
  [ "$host_tz" = "$dev_tz" ] || { printf 'UNTRUSTED:tz_mismatch\n'; return; }
  # 设备 epoch：秒（≤10 位）或毫秒（≥11 位），统一成 ms / sec
  if [ "${#draw}" -le 10 ]; then dev_ms=$(( draw * 1000 )); dev_sec="$draw"; else dev_ms="$draw"; dev_sec=$(( draw / 1000 )); fi
  drift_ms=$(( drift_max * 1000 ))
  # 采样区间判据：设备时刻必须落在 [before-drift, after+drift]（区间比较，容纳采样延迟）
  if [ "$dev_ms" -lt $(( before - drift_ms )) ] || [ "$dev_ms" -gt $(( after + drift_ms )) ]; then
    printf 'UNTRUSTED:clock_outside_sample_window\n'; return
  fi
  since_sec=$(( dev_sec - ML_LOOKBACK_SEC ))
  upper_sec=$(( after / 1000 + drift_max ))
  printf 'OK:%s:%s\n' "$since_sec" "$upper_sec"
}

# 设备端 logcat 命令（交给 adb shell 的单一 argv）。**只用 UTC epoch 格式**：
#   `-v epoch` 让时间戳成为 UTC epoch 秒（TZ 无关），**不加** localtime 的 `-t`
#   （那需要预先知道设备时区，且宿主 Node 格式化错配风险高）。窗口由本机按 epoch
#   数值过滤（ml_assess_logcat）。末尾 echo 把设备端 logcat 的真实 rc 带回本地。
# ⚠️ 真实设备 `-v epoch` 输出格式未在本机验证：解析不出 epoch 时间戳即 fail-closed。
ml_logcat_shell_cmd() {
  printf "logcat -d -v epoch 2>&1; echo __LOGRC__=\$?"
}

# logcat 证据判定（round4-B）：命令成功 + 无格式报错 + 非空 + **能从返回日志里解析出
# UTC epoch 时间戳并验证存在落在 [since, upper] 窗口内的行**，才可能 CLEAN。
#   · 未知格式（无 epoch 时间戳行，例如设备用了 localtime 输出 → 不同 TZ）/ 空 /
#     命令失败 / 窗口内无行 → INSUFFICIENT（fail-closed，绝不印 clean）。
#   · 崩溃关键字只在 **epoch 落在窗口内** 的行里找，旧崩溃栈不误报。
# 参数: <设备端 logcat rc> <输出文本> <since_epoch_sec> <upper_epoch_sec>
# 输出: CLEAN / CRASH / INSUFFICIENT:<reason>
ml_assess_logcat() {
  local rc="$1" body="$2" since="$3" upper="$4"
  local sec n_parse=0 n_in=0 crash=0 ln
  case "$rc" in ''|*[!0-9]*) printf 'INSUFFICIENT:bad_rc\n'; return;; esac
  [ "$rc" = "0" ] || { printf 'INSUFFICIENT:logcat_failed\n'; return; }
  printf '%s\n' "$body" | grep -qiE 'usage: logcat|logcat: (invalid|unknown|error|unrecognized)|unknown option|invalid time|bad time|not recognized|invalid modifier|invalid filter' \
    && { printf 'INSUFFICIENT:epoch_format_rejected\n'; return; }
  [ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] || { printf 'INSUFFICIENT:empty_output\n'; return; }
  # 严格逐行解析行首 UTC epoch 秒（logcat -v epoch: '<sec>.<frac> ...'）。
  while IFS= read -r ln; do
    sec="$(printf '%s\n' "$ln" | grep -oE '^[0-9]{9,11}\.[0-9]+' | cut -d. -f1)"
    [ -n "$sec" ] || continue
    case "$sec" in ''|*[!0-9]*) continue;; esac
    n_parse=$((n_parse + 1))
    if [ "$sec" -ge "$since" ] && [ "$sec" -le "$upper" ]; then
      n_in=$((n_in + 1))
      printf '%s\n' "$ln" | grep -qiE 'FATAL|AndroidRuntime' && crash=1
    fi
  done <<< "$body"
  # 没有任何可解析 epoch 时间戳 = 真实设备格式未验证 / 不是 -v epoch → fail-closed
  [ "$n_parse" -gt 0 ] || { printf 'INSUFFICIENT:epoch_format_unverified\n'; return; }
  # 窗口内没有行 = 无法验证窗口（缺少匹配日志时 fail-closed，绝不据空结果报 clean）
  [ "$n_in" -gt 0 ] || { printf 'INSUFFICIENT:no_in_window_lines\n'; return; }
  [ "$crash" = "1" ] && { printf 'CRASH\n'; return; }
  printf 'CLEAN\n'
}

# 最终闭环判定（round4-D）：只有所有验收项实际成功才 PASS。
# 参数: <FAILED 计数> <INSTALLED> <CRASH_CHECK> <SMOKE_RAN> [VERSION_OK]
# VERSION_OK 缺省为 1 以兼容旧 4 参调用；主流程显式传第 5 个参数。
# 输出: PASS / FAIL:<逗号分隔的未达成项>
ml_final_verdict() {
  local failed="$1" installed="$2" crash="$3" smoke="$4" version="${5:-1}" miss=""
  [ "$failed" = "0" ]     || miss="${miss}FAILED=${failed},"
  [ "$installed" = "1" ]  || miss="${miss}INSTALLED,"
  [ "$version" = "1" ]    || miss="${miss}VERSION_OK,"
  [ "$crash" = "1" ]      || miss="${miss}CRASH_CHECK,"
  [ "$smoke" = "1" ]      || miss="${miss}SMOKE_RAN,"
  if [ -z "$miss" ]; then printf 'PASS\n'; else printf 'FAIL:%s\n' "${miss%,}"; fi
}

# kbtiming --probe 判定（round5-D，纯函数）：显式 rc + 明确 PASS marker 双门槛。
#   · rc 必须是 0（由主流程用 PIPESTATUS[0] 显式取 node 的真实 rc，不被 tail/sed 掩盖）；
#   · 输出必须含独立、明确的 `KBTIMING_PASS` marker（普通诊断日志文本不含它）。
# kbtiming.cjs 目前是**纯诊断脚本**：只打印落点、既无断言式退出码也不打印该
# marker，故本项在当前仓库一律 FAIL → 主流程 fail() 计入 FAILED，绝不因管道末端
# tail/sed 成功就误报通过。不改 kbtiming.cjs（不扩大别文件），只在 shell 层处理。
# 参数: <node 真实 rc> <输出文本>
# 输出: PASS / FAIL:<reason>
ml_probe_assess() {
  local rc="$1" out="$2"
  case "$rc" in ''|*[!0-9]*) printf 'FAIL:bad_rc=%s\n' "${rc:-<空>}"; return;; esac
  [ "$rc" = "0" ] || { printf 'FAIL:probe_rc_nonzero=%s\n' "$rc"; return; }
  printf '%s\n' "$out" | grep -qE '(^|[^A-Za-z0-9_])KBTIMING_PASS([^A-Za-z0-9_]|$)' \
    || { printf 'FAIL:no_pass_marker\n'; return; }
  printf 'PASS\n'
}
# ==== END ML PURE HELPERS ====

# ===========================================================================
# 调用层辅助函数（ml_capture_adb / ml_install_and_verify 依赖 $ADB 与 fail()/ok()，
# 可抽取 + mock adb 测试「安装前阻断」；ml_dryrun_probe 只依赖 ml_assess_dryrun_rc
# 与 timeout，可抽取后用真实 publish 入口测「退出码判定 + 有界」）
# ==== BEGIN ML CALL HELPERS ====

# 捕获 adb **真实退出码**：stdout / stderr 分文件，tr 只用于事后清洗文本，
# 绝不出现在判定 rc 的管道里（不让 tr 成功覆盖 adb 失败）。
# 用法: ml_capture_adb <adb> <stdout_file> <stderr_file> <adb args...>
# 返回: adb 的真实退出码
ml_capture_adb() {
  local adb="$1" out="$2" err="$3"; shift 3
  MSYS_NO_PATHCONV=1 "$adb" "$@" > "$out" 2> "$err"
  return $?
}

# 装机 + 版本校验（前台唯一性门 → install → 版本校验）。设置全局 INSTALLED / VERSION_OK。
# 参数: <apk 路径> <目标包名> <期望 versionCode> <adb> <临时目录>
ml_install_and_verify() {
  local apk="$1" pkg="$2" code="$3" adb="$4" t="$5"
  local act_rc win_rc act_dump win_dump dec apk_win install_rc install_out info_rc info
  INSTALLED=0
  VERSION_OK=0
  # 两段 dumpsys 各自捕获真实 rc；tr 只清洗文本
  ml_capture_adb "$adb" "$t/act.out" "$t/act.err" shell "dumpsys activity activities"; act_rc=$?
  ml_capture_adb "$adb" "$t/win.out" "$t/win.err" shell "dumpsys window"; win_rc=$?
  act_dump="$(tr -d '\r' < "$t/act.out")"
  win_dump="$(tr -d '\r' < "$t/win.out")"
  dec="$(ml_front_decision "$pkg" "$act_rc" "$win_rc" "$act_dump" "$win_dump")"
  case "$dec" in
    ALLOW:*) ok "前台唯一 component ${dec#ALLOW:}（非目标包）；window 焦点与 Activity component 级一致，允许覆盖安装" ;;
    BLOCK:command_failed)        fail "dumpsys activity/window 命令失败（adb 真实 rc 未被 tr 掩盖），无法确认前台，fail-closed 跳过安装"; return ;;
    BLOCK:empty)                 fail "dumpsys 输出为空，无法确认前台，fail-closed 跳过安装"; return ;;
    BLOCK:unknown_format)        fail "dumpsys 读不到可解析的 resumed/top Activity component（空/未知格式/格式不全），fail-closed 跳过安装"; return ;;
    BLOCK:multiple_candidates)   fail "解析到多个 resumed/top Activity 候选，无法确认唯一，fail-closed 跳过安装"; return ;;
    BLOCK:focus_missing)         fail "window 焦点字段缺失，独立交叉核验无法完成，fail-closed 跳过安装"; return ;;
    BLOCK:focus_unknown_format)  fail "window 焦点字段读不到可解析 component（未知/格式不全），fail-closed 跳过安装"; return ;;
    BLOCK:focus_multiple)        fail "window 焦点解析到多个 component（或多窗口多组件），无法证明组件级一致，fail-closed 跳过安装"; return ;;
    BLOCK:focus_conflict)        fail "Activity 与 window 焦点指向不同包（交叉核验冲突），fail-closed 跳过安装"; return ;;
    BLOCK:component_mismatch)    fail "Activity 与 window 焦点 component 不一致（同包不同 Activity），fail-closed 跳过安装"; return ;;
    BLOCK:target_foreground)     fail "包 $pkg 正是前台/resumed component，跳过安装以免打断当前界面"; return ;;
    *)                           fail "前台判定异常（${dec:-空}），fail-closed 跳过安装"; return ;;
  esac

  # ⚠️ adb 是 Windows 程序：本地路径要写成盘符形式（见 docs/踩坑-环境.md）。
  apk_win="$(cd "$(dirname "$apk")" && pwd -W)/$(basename "$apk")"
  # install 不接管道吞 rc：用 ml_capture_adb 接住输出并显式判 rc
  ml_capture_adb "$adb" "$t/install.out" "$t/install.err" install -r "$apk_win"; install_rc=$?
  install_out="$(cat "$t/install.out" "$t/install.err" 2>/dev/null)"
  if [ "$install_rc" != "0" ]; then
    fail "adb install 失败（退出码 $install_rc，未被管道吞掉）"
    printf '%s\n' "$install_out" | tail -5 | sed 's/^/    /'
    return
  fi
  printf '%s\n' "$install_out" | tail -2 | sed 's/^/  /'
  ml_capture_adb "$adb" "$t/pkg.out" "$t/pkg.err" shell "dumpsys package $pkg 2>/dev/null"; info_rc=$?
  info="$(tr -d '\r' < "$t/pkg.out" | grep -E 'versionCode=|versionName=|pkgFlags' | head -3)"
  printf '%s\n' "$info" | sed 's/^/  /'
  if [ "$info_rc" = "0" ] && printf '%s\n' "$info" | grep -q "versionCode=$code"; then
    ok "versionCode 对上了（$code）"
    VERSION_OK=1
  else
    fail "装机后的 versionCode 不是 $code（dumpsys package rc=$info_rc）"
    return
  fi
  # 本地 debug 包本来就是 assembleDebug 产物，比对「是不是调试包」只对线上 release 有意义
  case "$apk" in
    *app-debug.apk) : ;;
    *) case "$info" in *DEBUGGABLE*) fail "装成了调试包（pkgFlags 有 DEBUGGABLE）"; return;; esac ;;
  esac
  INSTALLED=1
}

# dry-run 探针（round7 引入；round8 修 timeout fail-closed 与过度文案）：
# **同步直接子进程**调用 publish-apk.sh --machine-dry-run，判定只看它的真实退出码
# （见 ml_assess_dryrun_rc）。
#   · 不再有 coproc / 匿名 pipe / 第二次 read 等 EOF：没有读端等待，就没有 hang。
#   · timeout 只给**直接启动的发布子命令**设一个有界上限；超时信号的作用范围以
#     本机 timeout 工具的实际行为为准（默认向它启动的命令发 SIGTERM），**不保证**
#     能终止所有子进程 / 脱离进程组的后代，也不声称杀「全部进程组」。
#   · **缺 timeout 即 fail-closed**（round8，删除了原来「无 timeout 就无界直接调用」
#     的 fallback）：本函数最前面检查 command -v timeout，缺失时立即返回
#     ABNORMAL:timeout_missing，绝不执行 publish 命令（不产生 git fetch / 网络等
#     副作用），PUB_RC 保持空，错误结果不可能被判 EXPECTED_DRYRUN。生产 runtime
#     缺 timeout 即拒绝运行，不在目标真机未验证前假设该工具一定存在。
#   · stdout/stderr 只留作展示与错误摘要，**绝不参与判定**。
# 设置全局：DRY_DEC / PUB_RC / PUB_LOG / DRY_STDOUT。
# 参数: <publish 命令...>（真实入口：bash deploy/publish-apk.sh --machine-dry-run ...）
ml_dryrun_probe() {
  local rc dir out err
  DRY_DEC=""; PUB_RC=""; PUB_LOG=""; DRY_STDOUT=""
  [ "$#" -ge 1 ] || { DRY_DEC='ABNORMAL:no_publish_command'; return; }

  # round8：timeout 缺失 -> 立即 fail-closed。绝不无界直接调用 "$@"（那会让
  # publish 命令在没有任何超时保护下跑，且结果仍可能被判 EXPECTED_DRYRUN）。
  if ! command -v timeout >/dev/null 2>&1; then
    DRY_DEC='ABNORMAL:timeout_missing'
    return
  fi

  dir="$(mktemp -d /tmp/ml-dryrun.XXXXXXXXXXXX 2>/dev/null)" \
    || { DRY_DEC='ABNORMAL:probe_mktemp_failed'; return; }
  out="$dir/pub.out"; err="$dir/pub.err"

  # 同步直接子进程：shell 隐式 wait，rc 即该子进程真实退出码。
  # 退出状态由内核在 wait 时交给父进程，同 UID 的另一进程无法抢写。
  timeout "$ML_DRYRUN_TIMEOUT_SEC" "$@" > "$out" 2> "$err"
  rc=$?

  PUB_RC="$rc"
  DRY_STDOUT="$(cat "$out" 2>/dev/null)"
  PUB_LOG="$(cat "$out" "$err" 2>/dev/null)"
  DRY_DEC="$(ml_assess_dryrun_rc "$rc")"
  # 临时输出保留在 dir（不 rm：本机 BASH_ENV 的 rm 钩子会拦盘符路径，且留痕可审）
}

# ==== END ML CALL HELPERS ====

# ================================================================ 1 可追溯
step "1/7 可追溯性检查（发布路径不能有未提交改动）"
GS_OUT="$ML_EVIDENCE/gitstatus.out"; GS_ERR="$ML_EVIDENCE/gitstatus.err"
git status --porcelain > "$GS_OUT" 2> "$GS_ERR"; GS_RC=$?
if [ "$GS_RC" != "0" ]; then
  fail "git status --porcelain 失败（rc=$GS_RC），无法确认发布路径是否干净（fail-closed）"
  sed 's/^/    /' "$GS_ERR" | head -5
else
  DIRTY="$(awk '{print $2}' "$GS_OUT" \
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
fi

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
  LIVE_JSON="$(curl -sS "$BASE/dl/version.json" 2>"$ML_EVIDENCE/curl.err")"; CURL_RC=$?
  LIVE_CODE="$(echo "$LIVE_JSON" | grep -oE '"versionCode": *[0-9]+' | grep -oE '[0-9]+' | head -1)"
  echo "  本地 versionCode=$LOCAL_CODE  versionName=$LOCAL_NAME（网页版 $WEB_NAME）"
  echo "  线上 versionCode=${LIVE_CODE:-读不到}"

  [ -n "$LOCAL_CODE" ] || fail "build.gradle 里读不到 versionCode"
  if [ "$CURL_RC" != "0" ]; then
    fail "读取线上 version.json 失败（curl rc=$CURL_RC），无法确认 versionCode 递增（fail-closed）"
  elif [ -n "$LIVE_CODE" ] && [ "$LOCAL_CODE" -le "$LIVE_CODE" ] 2>/dev/null; then
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

# —— 只连一次；device connect 必须核 rc + 确认 devices 列表里确有该 device 状态 ——
DEVICE=""
CONNECT_NOTE=""
if [ -n "$DEVICE_ARG" ]; then
  ml_capture_adb "$ADB" "$ML_EVIDENCE/start.out"   "$ML_EVIDENCE/start.err"   start-server;                    START_RC=$?
  ml_capture_adb "$ADB" "$ML_EVIDENCE/connect.out" "$ML_EVIDENCE/connect.err" connect "$DEVICE_ARG";           CONNECT_RC=$?
  ml_capture_adb "$ADB" "$ML_EVIDENCE/devices.out" "$ML_EVIDENCE/devices.err" devices;                          DEVICES_RC=$?
  DEVICE_LIST="$(tr -d '\r' < "$ML_EVIDENCE/devices.out")"
  if [ "$START_RC" = "0" ] && [ "$CONNECT_RC" = "0" ] && [ "$DEVICES_RC" = "0" ] \
     && printf '%s\n' "$DEVICE_LIST" \
        | awk -v d="$DEVICE_ARG" 'NR>1 && $1==d && $2=="device"{f=1} END{exit f?0:1}'; then
    DEVICE="$DEVICE_ARG"
  else
    CONNECT_NOTE="设备连接未确认（start-server rc=$START_RC / connect rc=$CONNECT_RC / devices rc=$DEVICES_RC；或 devices 列表无该 device 状态）"
  fi
else
  ml_capture_adb "$ADB" "$ML_EVIDENCE/devices.out" "$ML_EVIDENCE/devices.err" devices; DEVICES_RC=$?
  DEVICE_LIST="$(tr -d '\r' < "$ML_EVIDENCE/devices.out")"
  if [ "$DEVICES_RC" = "0" ]; then
    DEVICE="$(printf '%s\n' "$DEVICE_LIST" | awk 'NR>1 && $2=="device"{print $1; exit}')"
  else
    CONNECT_NOTE="adb devices 命令失败（rc=$DEVICES_RC），无法确认在线设备"
  fi
fi
if [ -z "$DEVICE" ]; then
  fail "${CONNECT_NOTE:-没有在线设备（adb devices 无状态为 device 的条目）}"
  echo ""
  echo "  ┌ 需要你在手机上操作（约 30 秒）："
  echo "  │ 1. 设置 → 系统 → 开发者选项 → 无线调试（打开开关）"
  echo "  │ 2. 页面会显示一串「IP 地址和端口」，例如 192.168.1.172:39283"
  echo "  │    （每次开关该页面端口都会变，别用旧的）"
  echo "  │ 3. 把那串发给我，或 ./deploy/mobile-loop.sh --device IP:端口 重跑"
  echo "  └ 手机和电脑必须连同一个 WiFi"
  echo ""
  echo "== 闭环中止：没设备 / 连接未确认，发布 / 装机 / 只读状态检查都跳过"
  exit 1
else
  ok "设备 $DEVICE（已核 connect rc 且 devices 列表确认 device 状态）"
fi

APK=""
if [ -n "$DEVICE" ]; then
  if [ "$USE_DEBUG" = "1" ]; then
    APK="$ROOT/app/android/app/build/outputs/apk/debug/app-debug.apk"
    [ -f "$APK" ] || APK=""
  elif [ "$INSTALL_ONLY" = "1" ] || [ "$NO_PUBLISH" = "1" ]; then
    APK="$ROOT/app/android/app/build/outputs/apk/debug/app-debug.apk"
    [ -f "$APK" ] || APK=""
  fi

  if [ -z "$APK" ] && [ "$NO_PUBLISH" = "0" ] && [ "$INSTALL_ONLY" = "0" ]; then
    step "6/7a 发布 APK（publish-apk.sh）"

    # 发布授权（2026-11-09，Reviewer B）：本脚本**不自动**替用户加 --approve
    # （AGENTS.md 第 11 条）。只有调用方显式给 --approve（用户/主管授权）才把
    # --approve 透传给 publish-apk.sh 真正发版；否则只跑它的默认 dry-run
    # （不编译、不写远端生产），明确报「未授权发布」并让闭环失败。
    # ⚠️ 绝不把 dry-run 的 exit 1 当成「线上发布失败」再去查线上 version.json
    #    后继续装机 —— 那是把「根本没发」误判成「发失败后兜底放行」。
    if [ "$APPROVE" != "1" ]; then
      # 判定只看 publish-apk.sh --machine-dry-run 同步直接子进程的真实退出码（专用码 20）。
      # 不读 stdout/stderr 文本、不读任何文件/FD；同 UID 无法抢写退出状态。
      ml_dryrun_probe bash deploy/publish-apk.sh --machine-dry-run "手机端自动发版"
      case "$DRY_DEC" in
        EXPECTED_DRYRUN)
          echo "  未授权发布：以下只是 dry-run 摘要（未编译、未写生产；判定依据为 publish-apk.sh 专用退出码 20，非 stdout/文件/FD）——"
          printf '%s\n' "$DRY_STDOUT" | sed 's/^/    /' | tail -40
          echo "  publish-apk.sh 真实退出码：$PUB_RC（=20 才表示 preflight/SUMMARY 已就绪的无授权 dry-run）"
          echo ""
          fail "未授权发布：未给 --approve，本次仅 dry-run（未写生产）；真实发版须显式传 --approve（用户/主管授权）"
          echo ""
          echo "== 闭环中止：未授权发布 —— 未装机线上包、未写入线上"
          exit 1
          ;;
        ABNORMAL:*)
          fail "publish-apk.sh 未返回专用退出码 20（${DRY_DEC#ABNORMAL:}）—— preflight/env/闸门错误、参数异常或超时，不能据此确认 dry-run 就绪；fail-closed 停止、绝不装机"
          echo "  publish-apk.sh 真实退出码：$PUB_RC"
          echo "  ---- 原始 stdout/stderr 末尾（真实错误摘要，不作判定）----"
          printf '%s\n' "$PUB_LOG" | tail -20 | sed 's/^/    /'
          echo ""
          echo "== 闭环中止：publish 未就绪/异常（fail-closed，绝不继续装机；也不声称同 UID 隔离）"
          exit 1
          ;;
        *)
          fail "dry-run 判定异常（${DRY_DEC:-空}），中止"
          printf '%s\n' "$PUB_LOG" | tail -20 | sed 's/^/    /'
          exit 1
          ;;
      esac
    fi

    # ==== 以下仅 --approve 授权后才执行：真正发布并下载线上包去装 ====
    PUB_OK=0
    if bash deploy/publish-apk.sh --approve "手机端自动发版" > /tmp/m-pub.log 2>&1; then
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
      # 只有真正发版并成功下载线上 release 包，才标为线上发布（区分本地 debug）。
      [ -s "$APK" ] && PUB_MODE="online-release"
    fi
  fi

  if [ -n "$APK" ] && [ -f "$APK" ]; then
    step "6/7b 装机 + 版本校验（前台唯一性门 + window 焦点 component 级一致交叉核验）"
    # hash 路径：装机前记录本地包 SHA256，便于审阅「装的到底是哪个包」（信息项，非验收命令）
    APK_SHA="$(sha256sum "$APK" 2>/dev/null | cut -d' ' -f1)"
    echo "  本地包 SHA256=${APK_SHA:-读不到}（仅审阅用，失败不作验收项）"
    # 前台 BLOCK / adb 失败 / 版本校验不过 → fail() 计入 FAILED 且 INSTALLED=0，
    # 与最终闭环结论直接连起来（绝不跳过安装还报闭环通过）。
    ml_install_and_verify "$APK" "$PKG" "$LOCAL_CODE" "$ADB" "$ML_EVIDENCE"
  else
    fail "没有可安装的本地包（APK 为空或不存在）—— 未装机，不声称已装机"
  fi
fi

# ================================================================ 7 只读状态检查
step "7/7 只读状态检查（不打断 App / 不清日志 / 不拉起；崩溃检查 fail-closed；截屏为可选项非验收项）"
if [ -n "$DEVICE" ]; then
  # 真机数据保护（2026-11-09）：**不 force-stop、不 logcat -c、不 am start**。
  #   · force-stop 会掐掉用户正在用的 App（未保存的输入直接丢）；
  #   · logcat -c 会清空整台设备的系统日志，别处排障的线索一起没了；
  #   · am start 会把目标 Activity 拉到前台、抢走焦点。
  # 冒烟降级为**只读状态检查**：App 在跑就检查现有状态；没在跑只报「未启动/跳过」，
  # 不拉起。这不等于「完整冷启动冒烟」，摘要与最终说明都明确标注（本轮 finding #5）。
  RUNNING_RC=1; RUNNING=""; APP_RUNNING=0
  ml_capture_adb "$ADB" "$ML_EVIDENCE/pidof.out" "$ML_EVIDENCE/pidof.err" shell pidof "$PKG"; RUNNING_RC=$?
  RUNNING="$(tr -d '\r' < "$ML_EVIDENCE/pidof.out")"
  if [ "$RUNNING_RC" = "0" ] && [ -n "$RUNNING" ]; then
    ok "App 已在运行（pid $RUNNING）：仅做只读状态检查，不打断、不拉起"
    APP_RUNNING=1
  else
    echo "  App 当前未运行：只读状态检查不拉起 App（不 am start），本项记为未达成"
    APP_RUNNING=0
  fi

  # —— 崩溃只读检查（round4-B）：UTC epoch 端到端，严格 fail-closed ——
  #   1) 本机 UTC epoch(ms)+TZ 取采样**前 / 后**两次（ml_host_clock）；
  #      设备取 `date +%s %z`（UTC epoch 秒 + TZ），ml_capture_adb 捕获真实 rc。
  #   2) ml_clock_gate 要求 host/device **显式同一 TZ**、设备 epoch 落在采样区间；
  #      不同 TZ / TZ 未知 / 设备命令失败 → UNTRUSTED → 绝不报 clean。
  #   3) logcat 用 `-v epoch`（UTC epoch 时间戳，TZ 无关），本机按 epoch 数值过滤窗口。
  #   4) ml_assess_logcat 必须能从返回日志解析出 epoch 时间戳且存在窗口内行；
  #      命令失败 / 格式报错 / 空 / 未知格式 / 窗口内无行 → INSUFFICIENT（绝不印 clean）。
  HC_BEFORE="$(ml_host_clock)"; HOST_BEFORE="${HC_BEFORE%% *}"; HOST_TZ_B="${HC_BEFORE##* }"
  ml_capture_adb "$ADB" "$ML_EVIDENCE/devdate.out" "$ML_EVIDENCE/devdate.err" shell "date '+%s %z'"; DEV_RC=$?
  DEV_LINE="$(tr -d '\r' < "$ML_EVIDENCE/devdate.out")"
  DEV_RAW="${DEV_LINE%% *}"; DEV_TZ="${DEV_LINE##* }"
  HC_AFTER="$(ml_host_clock)"; HOST_AFTER="${HC_AFTER%% *}"; HOST_TZ_A="${HC_AFTER##* }"
  HOST_TZ="$HOST_TZ_B"; [ "$HOST_TZ_B" = "$HOST_TZ_A" ] || HOST_TZ=""
  CLOCK_DEC="$(ml_clock_gate "$HOST_BEFORE" "$HOST_AFTER" "$HOST_TZ" "$DEV_RAW" "$DEV_TZ" "$DEV_RC" "$ML_DRIFT_MAX_SEC")"
  case "$CLOCK_DEC" in
    OK:*)
      SINCE_SEC="${CLOCK_DEC#OK:}"; SINCE_SEC="${SINCE_SEC%%:*}"
      UPPER_SEC="${CLOCK_DEC##*:}"
      LOGCAT_CMD="$(ml_logcat_shell_cmd)"
      ml_capture_adb "$ADB" "$ML_EVIDENCE/logcat.out" "$ML_EVIDENCE/logcat.err" shell "$LOGCAT_CMD"; LOGCAT_ADB_RC=$?
      LOG_RAW="$(tr -d '\r' < "$ML_EVIDENCE/logcat.out")"
      LOG_RC="$(printf '%s\n' "$LOG_RAW" | sed -n 's/^__LOGRC__=//p' | tail -1)"
      LOG_BODY="$(printf '%s\n' "$LOG_RAW" | sed '/^__LOGRC__=/d')"
      # adb shell 自身 rc 非 0 也直接证据不足
      if [ "$LOGCAT_ADB_RC" != "0" ]; then
        LOG_DEC="INSUFFICIENT:adb_shell_failed"
      else
        LOG_DEC="$(ml_assess_logcat "$LOG_RC" "$LOG_BODY" "$SINCE_SEC" "$UPPER_SEC")"
      fi
      case "$LOG_DEC" in
        CLEAN)
          ok "只读崩溃检查：UTC epoch 时钟/同一 TZ 已核对、-v epoch 时间窗口已在返回日志里验证、窗口内无崩溃栈"
          CRASH_CHECK=1
          ;;
        CRASH)
          fail "只读崩溃检查：窗口内日志有崩溃栈"
          printf '%s\n' "$LOG_BODY" | grep -iE 'FATAL|AndroidRuntime' | head -5 | sed 's/^/    /'
          CRASH_CHECK=0
          ;;
        INSUFFICIENT:*)
          fail "只读崩溃检查证据不足（${LOG_DEC#INSUFFICIENT:}）：命令失败 / -v epoch 格式不被支持 / 无法验证时间窗口 —— fail-closed，绝不报无崩溃 / clean"
          printf '%s\n' "$LOG_BODY" | head -5 | sed 's/^/    /'
          CRASH_CHECK=0
          ;;
      esac
      ;;
    UNTRUSTED:*)
      fail "只读崩溃检查证据不足：本机/设备时钟或时区不可信（${CLOCK_DEC#UNTRUSTED:}；本机 '$HOST_BEFORE'/'$HOST_AFTER' TZ='$HOST_TZ' / 设备 '$DEV_RAW' TZ='$DEV_TZ' rc=$DEV_RC）—— fail-closed，不同 TZ 无法通过，绝不报无崩溃"
      CRASH_CHECK=0
      ;;
    *)
      fail "只读崩溃检查证据不足：时钟判定异常（${CLOCK_DEC:-空}），fail-closed"
      CRASH_CHECK=0
      ;;
  esac

  # 只读状态检查是否「执行且证据充分」：App 在跑 且 崩溃只读检查 clean。
  # 运行时未跑 / 证据不足都保留失败状态，最终绝不报闭环通过（本轮 finding #4）。
  if [ "$APP_RUNNING" = "1" ] && [ "$CRASH_CHECK" = "1" ]; then
    SMOKE_RAN=1
  else
    SMOKE_RAN=0
    [ "$APP_RUNNING" = "1" ] || fail "App 未运行：只读状态检查未执行（不拉起，不等价完整冷启动冒烟）"
  fi

  # 截屏：**可选项，非验收项**（不一致地把截图当验收项会导致「失败却仍报完整通过」）。
  # screencap 只读 framebuffer，不会把 Activity 拉到前台；但截到的是用户当前画面、内容敏感，
  # 只落本机 /tmp、不外发、不自动上传。失败**不置 FAILED**，也从不据此宣称完整通过。
  SHOT="$(cd /tmp && pwd -W)/mobile-$(date +%H%M%S).png"
  SHOT_RC_SCAP=1; SHOT_RC_PULL=1
  for try in 1 2; do
    ml_capture_adb "$ADB" "$ML_EVIDENCE/scap.out" "$ML_EVIDENCE/scap.err" shell "screencap -p /sdcard/loop.png"; SHOT_RC_SCAP=$?
    ml_capture_adb "$ADB" "$ML_EVIDENCE/pull.out" "$ML_EVIDENCE/pull.err" pull /sdcard/loop.png "$SHOT"; SHOT_RC_PULL=$?
    [ -s "$SHOT" ] && break
    sleep 1
  done
  if [ -s "$SHOT" ] && [ "$SHOT_RC_SCAP" = "0" ] && [ "$SHOT_RC_PULL" = "0" ]; then
    echo "  [可选项/非验收项] 截屏 $SHOT（仅本地保存、不外发；请用 Read 人工核对红条/角标）—— 不计入闭环验收"
  else
    echo "  [可选项/非验收项] 截屏未取得（screencap rc=$SHOT_RC_SCAP / pull rc=$SHOT_RC_PULL）—— 不置 FAILED，也不宣称含截图验收/完整通过"
  fi

  if [ "$PROBE" = "1" ]; then
    step "7/7b 坐标时序回归（kbtiming；诊断项，rc + PASS marker 双校验）"
    # round5-D：显式用 PIPESTATUS[0] 保存 node 的真实 rc（不被 tail/sed 掩盖），
    # 并校验输出含明确 PASS marker。kbtiming.cjs 目前是纯诊断脚本，既无断言式
    # 返回码也不打印 KBTIMING_PASS → 本项一律判未达成、fail() 计入 FAILED，
    # 绝不因管道末端 tail/sed 成功就报通过。不扩大到别的文件，仅 shell 层处理。
    PROBE_OUT_FILE="$ML_EVIDENCE/probe.out"
    ( cd app && NODE_PATH="$ROOT/app/node_modules" node ../deploy/kbtiming.cjs 2>&1 ) \
      | tail -4 | sed 's/^/  /' > "$PROBE_OUT_FILE"
    PROBE_PIPE=( "${PIPESTATUS[@]}" )
    cat "$PROBE_OUT_FILE"
    PROBE_RC="${PROBE_PIPE[0]:-1}"
    PROBE_DEC="$(ml_probe_assess "$PROBE_RC" "$(cat "$PROBE_OUT_FILE" 2>/dev/null)")"
    case "$PROBE_DEC" in
      PASS) ok "--probe 坐标时序回归通过（node rc=0 且含 KBTIMING_PASS marker）" ;;
      FAIL:*)
        fail "--probe 坐标时序回归未达成（${PROBE_DEC#FAIL:}）：已用 PIPESTATUS[0]=$PROBE_RC 显式校验 node 真实 rc 且要求明确 PASS marker；kbtiming.cjs 不提供可靠通过语义，计入 FAILED，绝不据此宣称通过"
        ;;
    esac
  fi
fi

# ================================================================ 结论
echo ""
echo "—— 需要你真手指验收（只读状态检查无法替代，键盘只能真实手势唤出）——"
echo "  1. 点日程空白处：输入框是否稳定存在、能否打字、时间是否整点"
echo "  2. 手动按「收起键盘」：空着的输入框自动消失；打过字的保留"
echo "  3. 键盘弹起时点别的空白：新框是否落在你点的位置"
echo ""
if [ "$PUB_MODE" = "online-release" ]; then
  MODE_NOTE="线上发布（已装线上下载并回读校验过的 release 包）"
else
  MODE_NOTE="本地测试（仅装本地 debug 包 / 未做线上发布）；默认 dry-run / --no-publish / --install-only 均属此类，不代表与线上一致、不等价线上发布"
fi
echo "  验收汇总：FAILED=$FAILED INSTALLED=$INSTALLED VERSION_OK=$VERSION_OK CRASH_CHECK=$CRASH_CHECK SMOKE_RAN=$SMOKE_RAN"
echo "  发布模式：$MODE_NOTE"
# 只在所有验收项**实际成功**时打印闭环通过；任何跳过安装 / 运行时未跑 / 证据不足
# 都保留失败状态并列出未达成项，绝不误报「已装机 / 与线上一致」。
VERDICT="$(ml_final_verdict "$FAILED" "$INSTALLED" "$CRASH_CHECK" "$SMOKE_RAN" "$VERSION_OK")"
case "$VERDICT" in
  PASS)
    printf '\033[32m== 闭环通过（本次：%s）：已装机且 versionCode 与本地 build.gradle 校验一致；崩溃日志只读检查证据充分；仅完成「只读状态检查」（不等价完整冷启动冒烟；设备截图为可选项、不计入验收）\033[0m\n' "$MODE_NOTE"
    ;;
  FAIL:*)
    printf '\033[31m== 闭环未通过：以下验收项未达成 [%s]\033[0m\n' "${VERDICT#FAIL:}"
    [ "$INSTALLED" = "1" ]   || echo "  ✗ 未成功装机 / 版本校验（INSTALLED=0）—— 不能声称已装机或与线上一致"
    [ "$VERSION_OK" = "1" ] || echo "  ✗ versionCode 校验未通过（VERSION_OK=0）"
    [ "$CRASH_CHECK" = "1" ] || echo "  ✗ 崩溃只读检查证据不足或未 clean（CRASH_CHECK=0）—— 不报无崩溃"
    [ "$SMOKE_RAN" = "1" ]   || echo "  ✗ 运行时只读状态检查未完成（SMOKE_RAN=0）—— App 未运行则不拉起，不等价完整冷启动冒烟"
    echo "  · 发布模式：$MODE_NOTE（本地测试不等于线上一致 / 线上发布）"
    if [ "${#FAIL_ITEMS[@]}" -gt 0 ]; then
      for f in "${FAIL_ITEMS[@]}"; do echo "  ✗ $f"; done
    fi
    echo ""
    echo "下一步：按未达成项修 → 提交 → 重跑 ./deploy/mobile-loop.sh"
    exit 1
    ;;
esac
