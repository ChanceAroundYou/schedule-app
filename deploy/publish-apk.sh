#!/usr/bin/env bash
#
# 发布一个新版 APK 到服务器，供 App 自更新拉取。
#
#   ./deploy/publish-apk.sh                          # 默认 dry-run：不编译、不写远端生产
#   ./deploy/publish-apk.sh "修了打卡回弹"           # dry-run，带更新说明
#   ./deploy/publish-apk.sh --approve "修了打卡回弹"  # 真的编译 + 发布（才写生产）
#   ./deploy/publish-apk.sh --machine-dry-run        # 内部：mobile-loop 用的可判定 dry-run（退出码 20）
#
# ⚠️ **默认严格 dry-run**（2026-11-09，与 publish-web.sh / publish-server.sh
#    同一道闸，见 deploy/preflight.sh）：不加 --approve 只做 pf_gather + 打印
#    「要发什么、发到哪、来源分支是哪个提交」，随后 exit 1 —— 不 assembleRelease、
#    不上传 version.json、不写 app.version。任何自动化（定时器 / 批量 / AI 自跑）
#    都越不过这道闸；只有显式 --approve 且 pf_gate 体检通过才会动生产。
#    AGENTS.md 第 11 条：不替用户加 --approve。**这次 worker 不真实执行发布**，
#    默认 dry-run 与显式 approve 的保留，仅当当前已批准的 user request 足以授权
#    真实发布时才成立；脚本本身不替任何调用方补 --approve。
#
# ⚠️ **dry-run 不是零副作用**：闸门前的 pf_gather（preflight.sh）会先跑一次
#    `git fetch --quiet <remote> <branch>`，用来算「未推送 / 落后」是不是真的 ——
#    这条命令会**修改本地仓库的远端跟踪引用（`refs/remotes/*`，即 local remote
#    refs）**并读一遍远端状态。它不改远端仓库、不改工作区文件、不编译、不碰 APK
#    产物、不写**远端生产**（不上传、不写 app.version），但别把「只打印摘要」
#    理解成「对本地仓库也毫无影响」：会动的是本地的 remote-tracking refs。
#    mobile-loop.sh 默认同样不发布；只有显式给它 --approve（用户/主管在已授权
#    主流程中显式传入）时，它才把 --approve 透传给本脚本。**单独跑本脚本永远是
#    dry-run，不应默认替调用方加 --approve**。
#
# ⚠️ **dry-run 判定走专用退出码（round7，替换 round5 的匿名 FD 结果通道）**：
#    mobile-loop.sh 以**同步直接子进程**调用本脚本的 `--machine-dry-run` 内部模式，
#    只有该模式返回**专用退出码 20**（= pf_gather/preflight 已成功且 gate 前
#    SUMMARY 状态齐全的无授权 dry-run）才被判定为「预期的 dry-run 就绪」；
#    任何其它退出码（preflight / env / 参数错误 exit 1、超时被 kill 等）一律
#    fail-closed。退出状态由内核在 wait 时交给父进程，**同 UID 的另一进程无法
#    抢写**，故不再需要 nonce / 匿名 pipe / 结果文件，也**不读 stdout/stderr 文本**
#    下结论（摘要只作展示）。
#    · 早先的匿名 FD 通道已整体删除：ml_fd_channel_guard 只测 FD9 却用 FD3，
#      且匿名 pipe 无法一般性证明同 UID 进程不可伪造 —— 不声称隔离、不伪造 security。
#    · 本脚本不读取任何结果通道环境变量（APK_RESULT_FD / APK_PUBLISH_NONCE /
#      APK_PUBLISH_RESULT_FILE）；它们对判定无影响。
#    · `--machine-dry-run` 与 `--approve` 同用会被拒绝（安全默认 dryrun），
#      未授权外部直接调用本脚本仍是默认 dry-run（exit 1），绝不自动发布。
#    · 单独运行本脚本（不带 --machine-dry-run）行为不变；不改 preflight.sh。
#
# ⚠️ **round8 返工（fail-closed 收窄，替代 round7 简单「8 字段非空」判定）**：
#    preflight.sh 的 pf_gather 内部多处 `|| true` 与占位符兜底（<无分支> / unknown /
#    空 upstream 与「确实无上游」混淆）会把「某一步 git 采集失败」伪装成非空合法值，
#    而 round7 的 machine 门禁只查 8 个字段非空、根本不查 PF_UPSTREAM —— 无法在
#    两文件限定内证明 preflight 内部每步都成功。故本脚本改为双保险后才返回 20：
#      · 参数阶段：`--machine-dry-run` 与 `--approve` 冲突在 pf_gather（git fetch）
#        **之前**立即 die，冲突组合绝不触发网络/远端操作（授权路径无 machine flag）；
#      · 严格自检：pub_strict_git_probe 用「检查真实 rc、不吞错误」的方式独立重读
#        branch/sha/upstream，与 pf_gather 全局变量交叉核对，不一致即 die；
#      · 纯判定：pub_assess_summary 拒绝空值 / 占位符 / 非法格式 / 空 upstream，
#        只有 SUMMARY_READY 才 exit 20。任一采集失败/不确定 → die（非 20，fail-closed）。
#    不改 preflight.sh（第三文件），不影响 publish-web.sh / publish-server.sh。
#
# 通过授权后做五件事：
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

# say/die 必须在 pf_parse_args / pf_gate 之前定义：preflight.sh 的未知参数分支
# 和闸门体检都会调 die。（preflight.sh 顶层 source 时的自检走它自己的 _pf_die
# 兜底，不依赖这里。）
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ===========================================================================
# 纯判定函数（无 ssh / git / 网络 / adb 副作用）—— 供本地 mock 测试直接 source 调用。
# 本段自包含：只拼字符串 / 清洗字段，用到的常量都在段内定义。
# ==== BEGIN PUB PURE HELPERS ====
PUB_STATUS_PREFIX='APK_PUBLISH_STATUS'   # stdout 状态行前缀：仅人类可读/展示，绝不作为判定依据

# 字段值清洗：结构行是空格分隔的 key=value，值里不能出现空白，否则会被误拆成
# 多个字段。只把空白压成 '_'，其余字符（/ ~ : . - 等）保留，便于人直接读懂目标路径。
pub_field() {
  printf '%s' "${1:-}" | tr '[:space:]' '_' | tr -d '\r\n'
}

# 生成一条机器可读的状态行（纯函数，不读环境、不写 IO）。**仅展示/审计用**：
# mobile-loop.sh 的判定完全不解析它（只看真实退出码），任何伪造的 stdout 行都无效。
# 参数: <result> <phase> <rc> <approve> <branch> <sha> <dest> <code> <name>
# result 取值：PREFLIGHT_OK / DRY_RUN_UNAUTHORIZED / GATE_PASS
# phase  取值：preflight / pf_gate / gate_pass
pub_status_line() {
  local result="$1" phase="$2" rc="$3" appr="$4" branch="$5" sha="$6" dest="$7" code="$8" name="$9"
  printf '%s result=%s phase=%s rc=%s approve=%s branch=%s sha=%s target=%s versionCode=%s versionName=%s\n' \
    "$PUB_STATUS_PREFIX" "$result" "$phase" "$rc" "$appr" \
    "$(pub_field "$branch")" "$(pub_field "$sha")" "$(pub_field "$dest")" \
    "$(pub_field "$code")" "$(pub_field "$name")"
}

# round8 纯判定：严格校验 pf_gather 采集字段，拒绝空值 / preflight 占位符 / 非法格式 /
# 不确定状态。输出 SUMMARY_READY 或 SUMMARY_REJECT:<reason>；只有 READY 才允许
# --machine-dry-run 返回专用退出码 20（fail-closed）。不读环境、不写 IO（仅 stdout）。
# ⚠️ preflight.sh 的 pf_gather 内部多处 `|| true` 与占位符兜底（<无分支> / unknown /
#    空 upstream 与「确实无上游」混淆）会把「某一步 git 采集失败」伪装成非空合法值；
#    本函数把这些兜底值一律判 REJECT，再由 pub_strict_git_probe 额外严格重读 git
#    交叉核对，双保险确保 preflight 内部静默失败时退出码绝不为 20。不改 preflight.sh。
# 参数: <branch> <sha> <upstream> <dirty_n> <unpushed> <behind> <fetch> <version> <host>
pub_assess_summary() {
  local branch="${1:-}" sha="${2:-}" upstream="${3:-}" \
        dirty="${4:-}" unpushed="${5:-}" behind="${6:-}" \
        fetch="${7:-}" version="${8:-}" host="${9:-}" n
  case "$branch" in
    ''|'<无分支>'|'unknown'|'HEAD') printf 'SUMMARY_REJECT:branch\n'; return;;
  esac
  case "$sha" in
    ''|*[!0-9a-fA-F]*) printf 'SUMMARY_REJECT:sha\n'; return;;
  esac
  [ "${#sha}" -ge 7 ] && [ "${#sha}" -le 40 ] \
    || { printf 'SUMMARY_REJECT:sha_len\n'; return; }
  # 空 upstream 无法在两文件限定内区分「git rev-parse @{u} 失败」与「确实未配置上游」，
  # 故保守 REJECT（收窄：只在确知上游存在时通过）。
  [ -n "$upstream" ] || { printf 'SUMMARY_REJECT:upstream_absent\n'; return; }
  for n in "$dirty" "$unpushed" "$behind"; do
    case "$n" in ''|*[!0-9]*) printf 'SUMMARY_REJECT:count\n'; return;; esac
  done
  # 只有 fetch=ok 才通过：remote(fetch) 失败(fail) 或根本没 fetch(skip) 时，
  # 「未推送/落后」依据的是过期/缺失的远端状态，不算「一切采集成功」——保守 REJECT，
  # 确保 remote 失败 / 空输出 / 占位值都拿不到专用退出码 20。
  [ "$fetch" = 'ok' ] || { printf 'SUMMARY_REJECT:fetch\n'; return; }
  case "$version" in ''|'unknown') printf 'SUMMARY_REJECT:version\n'; return;; esac
  case "$host" in ''|'unknown') printf 'SUMMARY_REJECT:host\n'; return;; esac
  printf 'SUMMARY_READY\n'
}
# ==== END PUB PURE HELPERS ====

# ==== BEGIN PUB STRICT PROBE ====
# round8 额外严格 git 状态自检：用「检查真实 rc、不吞错误、不补占位符」的方式独立
# 重读关键字段，供 --machine-dry-run 与 pf_gather 全局变量交叉核对。
# 只跑只读 git 命令（不 fetch、不改 refs、不碰远端生产），任一失败即返回非 0。
# 输出（stdout，tab 分隔）：branch<TAB>sha<TAB>upstream
pub_strict_git_probe() {
  cd "$ROOT" 2>/dev/null || { printf 'strict: 无法 cd 仓库根 %s\n' "$ROOT" >&2; return 1; }
  local b s u
  b="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" \
    || { printf 'strict: branch 命令失败（val=%s）\n' "$b" >&2; return 1; }
  [ -n "$b" ] && [ "$b" != 'HEAD' ] \
    || { printf 'strict: branch 为空/detached 占位（val=%s）\n' "$b" >&2; return 1; }
  s="$(git rev-parse --short HEAD 2>/dev/null)" \
    || { printf 'strict: sha 命令失败（val=%s）\n' "$s" >&2; return 1; }
  [ -n "$s" ] || { printf 'strict: sha 为空\n' >&2; return 1; }
  u="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" \
    || { printf 'strict: 上游解析失败；两文件内无法区分 git 故障与无上游，保守拒绝\n' >&2; return 1; }
  [ -n "$u" ] || { printf 'strict: 上游为空，保守拒绝\n' >&2; return 1; }
  printf '%s\t%s\t%s\n' "$b" "$s" "$u"
}
# ==== END PUB STRICT PROBE ====

# ---------------------------------------------------------------------------
# 默认严格 dry-run（2026-11-09）。复用 preflight.sh 的**共用参数**（pf_parse_args
# 一次扫全量，开关顺序无所谓，未知 --xxx 直接 die）与**同一道闸门**
# （pf_gather + pf_gate，与 publish-web.sh / publish-server.sh 一致）。
#
# 闸门刻意放在**编译之前**：assembleRelease 要几分钟，dry-run 不该白白编译。
# 但 pf_gather 仍会执行（含 git fetch，改本地 refs/remotes，见文件头说明）——
# dry-run 不编译、不写远端生产，**不是零副作用**。
#
# 与 mobile-loop.sh 的约定（round7，替换 round5 匿名 FD 通道 / 更早的 stdout 协议）：
#   · **判据只有一个：本脚本的真实退出码**。mobile-loop 以同步直接子进程调用
#     `--machine-dry-run`，只认退出码 20；不读 stdout/stderr 文本、不读任何文件/FD。
#   · stdout 的 `pub_status_line` 与 `pf_print_summary` 仅**人类可读/展示**。
#   · `--machine-dry-run`（round8）：pf_gather 成功 + 严格 git 自检一致 +
#     pub_assess_summary=SUMMARY_READY + 未授权 → exit 20；preflight/env/参数错误、
#     任一采集静默失败/占位/不确定 → die 走其它退出码（非 20），mobile-loop 据此 fail-closed。
#   · 有 --approve 且 pf_gate 体检通过 → 打印 phase=gate_pass，之后才可能写生产。
#   · **不改 preflight.sh**：`--machine-dry-run` 用本脚本自己的控制流返回 20，
#     不碰 pf_gate / pf_approve_or_exit（其它发布脚本复用不受影响）。
# ---------------------------------------------------------------------------
PUB_MACHINE_DRYRUN=0
PUB_ARGS=()
for _pa in "$@"; do
  case "$_pa" in
    --machine-dry-run) PUB_MACHINE_DRYRUN=1 ;;
    *)                 PUB_ARGS+=("$_pa") ;;
  esac
done
pf_parse_args "${PUB_ARGS[@]}"

# round8（Reviewer finding 5）：机器选项与授权选项冲突，必须**早于任何网络操作**
# 立即拒绝。pf_gather 内部会跑 `git fetch`（改本地 remote refs、读远端状态），把它
# 放在拒绝之前等于「冲突组合也会触发网络/远端操作」。授权路径本身不带 machine flag，
# 故在参数剥离 + pf_parse_args 之后、pf_gather 之前就地 die：此时尚未有任何 git /
# ssh / curl 调用，也未编译、未写生产。原参数门 / 发布门功能不变。
if [ "$PUB_MACHINE_DRYRUN" = "1" ] && [ "$PF_APPROVE" = "1" ]; then
  die "--machine-dry-run 不能与 --approve 同用（拒绝超授权；安全默认 dryrun，参数阶段即拒绝，未触发 git fetch 或任何网络/远端操作，生产未做任何改动）"
fi

# 更新说明：兼容旧的「第一个位置参数就是说明」用法。pf_parse_args 已经把
# 所有 --xxx 开关扫过（未知的当场 die），这里只挑出剩下的非选项参数。
# --machine-dry-run 已在上方剥离，不会落到这里。顺序无关。
NOTES=""
NOTES_N=0
for a in "${PUB_ARGS[@]}"; do
  case "$a" in
    --*) : ;;                                   # 开关，已由 pf_parse_args 处理
    -*)  die "未知参数：$a" ;;                  # 单横线选项本脚本不支持
    *)   NOTES="$a"; NOTES_N=$((NOTES_N + 1)) ;;
  esac
done
[ "$NOTES_N" -le 1 ] || die "更新说明只能给一个（收到 $NOTES_N 个位置参数）"
[ -n "$NOTES" ] || NOTES="$(date '+%Y-%m-%d 发布')"

# 摘要里的版本只解析 build.gradle —— dry-run 不编译、不调 aapt、不碰产物。
# 真正发版时仍以 APK badging 为准（见 2/4），这里只是「打算发哪一版」。
GRADLE_FILE="$ANDROID/app/build.gradle"
META_CODE="$(grep -oE 'versionCode [0-9]+' "$GRADLE_FILE" 2>/dev/null | head -1 | awk '{print $2}')"
META_NAME="$(grep -oE 'versionName "[^"]+"' "$GRADLE_FILE" 2>/dev/null | head -1 | sed 's/.*"\(.*\)"/\1/')"
[ -n "$META_CODE" ] || META_CODE="unknown"
[ -n "$META_NAME" ] || META_NAME="unknown"

DEST="$SSH_HOST:$REMOTE_DIR/version.json"
PUB_GATE_ARGS=(
  "APK 版本   versionCode=$META_CODE versionName=$META_NAME（仅解析 build.gradle，未编译）"
  "更新说明   $NOTES"
  "发布动作   上传 APK + version.json，回读校验后写 app.version"
  "通过后才   assembleRelease → 读产物版本/包名/签名 → 版本递增校验 → 上传"
)

# —— preflight 阶段：pf_gather（含 git fetch，改本地 remote refs）——
# 这里若 die（git 跑不动 / dubious ownership / 算不出未推送落后），是**原始错误**，
# 退出码非 20；mobile-loop.sh 会打印原始错误摘要并停止，绝不继续装机。
pf_gather
# pf_gather 成功才打 preflight 完成标记（明确 phase；仅展示，不作判定）。
pub_status_line PREFLIGHT_OK preflight 0 "$PF_APPROVE" \
  "$PF_BRANCH" "$PF_SHA" "$DEST" "$META_CODE" "$META_NAME"

# ==== 内部机器 dry-run：专用退出码 20（round7 引入，round8 fail-closed 收窄）====
# 只有「pf_gather 已成功 + 严格 git 自检一致 + 纯判定 SUMMARY_READY + 未授权」才返回 20。
# 这是 mobile-loop.sh 唯一认作「dry-run 就绪」的信号；由本脚本自己的控制流产生，
# 不改 preflight.sh 的 pf_approve_or_exit（那会波及 publish-web.sh / publish-server.sh）。
if [ "$PUB_MACHINE_DRYRUN" = "1" ]; then
  # 纵深防御：冲突已在参数阶段（pf_gather 之前）拒绝；这里再挡一次，绝不放行超授权。
  [ "$PF_APPROVE" != "1" ] \
    || die "--machine-dry-run 不能与 --approve 同用（拒绝超授权；安全默认 dryrun，生产未做任何改动）"

  # round8：额外严格 git 自检 —— 检测 pf_gather 内部 `|| true` / 占位符造成的静默失败。
  PUB_STRICT="$(pub_strict_git_probe)" \
    || die "严格 git 自检失败：preflight 采集可能有步骤静默失败，拒绝返回专用退出码 20（fail-closed，生产未做任何改动）"
  IFS=$'\t' read -r S_BRANCH S_SHA S_UPSTREAM <<< "$PUB_STRICT" \
    || die "严格 git 自检输出解析失败，拒绝返回 20（fail-closed）"
  # 交叉核对：pf_gather 若某步被 || true / 占位符掩盖，其全局值会与严格真值不符。
  [ "${PF_BRANCH:-}" = "$S_BRANCH" ] \
    || die "SUMMARY 分支与严格自检不一致（pf_gather=${PF_BRANCH:-<空>} / strict=$S_BRANCH），拒绝返回 20（fail-closed）"
  [ "${PF_SHA:-}" = "$S_SHA" ] \
    || die "SUMMARY 提交与严格自检不一致，拒绝返回 20（fail-closed）"
  [ "${PF_UPSTREAM:-}" = "$S_UPSTREAM" ] \
    || die "SUMMARY 上游与严格自检不一致，拒绝返回 20（fail-closed）"

  # round8 纯判定：拒绝空值 / preflight 占位符 / 非法格式 / 空 upstream / 不确定状态。
  PUB_ASSESS="$(pub_assess_summary "${PF_BRANCH:-}" "${PF_SHA:-}" "${PF_UPSTREAM:-}" \
    "${PF_DIRTY_N:-}" "${PF_UNPUSHED:-}" "${PF_BEHIND:-}" "${PF_FETCH:-}" \
    "${PF_VERSION:-}" "${PF_HOST:-}")" \
    || die "SUMMARY 判定异常，拒绝返回 20（fail-closed）"
  [ "$PUB_ASSESS" = "SUMMARY_READY" ] \
    || die "SUMMARY 未就绪（$PUB_ASSESS）：preflight 状态字段缺失/占位/非法或与严格自检不符，拒绝返回专用退出码 20（fail-closed，生产未做任何改动）"

  pf_print_summary "$DEST" "${PUB_GATE_ARGS[@]}"
  pub_status_line DRY_RUN_UNAUTHORIZED pf_gate 20 "$PF_APPROVE" \
    "$PF_BRANCH" "$PF_SHA" "$DEST" "$META_CODE" "$META_NAME"
  printf '\n\033[1;33m== machine dry-run 结束（专用退出码 20：严格自检 + SUMMARY ready / 未授权）—— 生产未做任何改动。\033[0m\n'
  printf '  该退出码由同步直接子进程返回，mobile-loop.sh 仅凭它判定；stdout 不作判定。\n'
  exit 20
fi

if [ "$PF_APPROVE" != "1" ]; then
  # 默认 dry-run（未授权外部直接调用仍安全默认 dryrun）：只打印摘要，exit 1。
  # 与 --machine-dry-run 的区别仅在退出码：1 = 未授权、不可被自动判定；
  # 20 = 未授权且 preflight/SUMMARY 已就绪、可被 mobile-loop 判定。两者都不写生产。
  pf_print_summary "$DEST" "${PUB_GATE_ARGS[@]}"
  pub_status_line DRY_RUN_UNAUTHORIZED pf_gate 1 "$PF_APPROVE" \
    "$PF_BRANCH" "$PF_SHA" "$DEST" "$META_CODE" "$META_NAME"
  printf '\n\033[1;33m== dry-run 结束（退出码 1：未授权）—— 生产未做任何改动。\033[0m\n'
  printf '  确认上面都对，再加 --approve 重跑。\n'
  exit 1
fi

# ==== 有 --approve：走 pf_gate 体检（上游/未提交/未推送），通过才继续 ====
pf_gate "$DEST" "${PUB_GATE_ARGS[@]}"
pub_status_line GATE_PASS gate_pass 0 "$PF_APPROVE" \
  "$PF_BRANCH" "$PF_SHA" "$DEST" "$META_CODE" "$META_NAME"

# ==== 以下全部只有 --approve 且 pf_gate 通过才会执行（含所有 SSH 写）====

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
# ⚠️ Windows 的 build-tools 里只有 apksigner.bat，没有无扩展名的那个。
# 以前这里只判断了 `.bat` 存不存在，却仍然去执行不带后缀的路径 → 命令找不到 →
# SIGN_OUT 为空 → 当成「签名校验没过」直接拒绝发版。要执行谁就指向谁（2026-11-07）。
if [ ! -x "$APKSIGNER" ] && [ -f "$APKSIGNER.bat" ]; then
  APKSIGNER="$APKSIGNER.bat"
fi
if [ -x "$APKSIGNER" ] || [ -f "$APKSIGNER" ]; then
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
