#!/usr/bin/env bash
#
# 发布前置校验 —— 被 publish-web.sh / publish-server.sh `source`，不单独跑。
#
# ⚠️ 为什么需要这道闸门（2026-10-15，双端开发之后）：
#   两侧（Windows 本机 / ubuntu 工程目录）都会推进开发，生产在 ubuntu 本机磁盘
#   ~/.local/schedule/ 下。要让「生产环境锁定」成立，光靠文档不够 ——
#   **默认 dry-run，只有显式 --approve 才动生产**。这样任何自动化（定时器、
#   批量操作、AI 自己跑脚本）都不会越过你发出去。
#
#   顺带做两项体检，保证「线上跑的版本」能追溯回仓库：
#     · 工作区不能有未提交改动（--allow-dirty 例外）
#     · 当前分支不能有未推送的提交（--allow-unpushed 例外）
#
# 提供：
#   pf_parse_args "$@"                解析公共参数
#   pf_gather                         采集来源工作区状态
#   pf_print_summary <目标路径> [附言]  打印发布摘要
#   pf_approve_or_exit               没 --approve 就到此为止（回滚路径也用它）
#   pf_gate <目标路径> [附言]          摘要 + 体检 + 授权
#   pf_write_version <target> [版本] [备注]
#
# 依赖调用方已定义：ROOT、SSH_HOST

# ---------------------------------------------------------------- ssh 可执行文件
#
# 三级探测，和 `app/tests/lib/probe-env.mjs` 选 Chrome 是同一套思路：
#   1. `SSH=` 环境变量（明确指定时永远听它的）
#   2. 系统自带的 ssh.exe —— **Windows / Git Bash 必须走这条**，因为 MSYS 自带的
#      `ssh` 不读 `~/.ssh/config` 里的 Host 别名（`ssh ubuntu` 会退化成用本机名
#      当用户名，然后 publickey 失败）
#   3. PATH 里的 `ssh` —— Linux / macOS 这条就对
#
# ⚠️ 2026-10-25 修：以前这里写死 `SSH=/c/Windows/System32/OpenSSH/ssh.exe`，
#    在 Linux 侧（这台 NAS 的工程目录、ubuntu 那份工作副本）**根本没有这个文件**。
#    失败被下面两处 `|| true` 吞掉，症状是：
#      · 远端指纹恒为 `<空>` → 「无变更 → 跳过」永远不触发，每次都当成有变更
#      · 回滚时报「没有找到任何备份」—— 明明是 ssh 起不来，看起来像没备份
#    比报错难查得多，所以宁可在这里探测，也别再写死一个平台的路径。
pick_ssh() {
  if [ -n "${SSH:-}" ]; then printf '%s' "$SSH"; return; fi
  local c
  for c in '/c/Windows/System32/OpenSSH/ssh.exe' \
           'C:/Windows/System32/OpenSSH/ssh.exe'; do
    [ -x "$c" ] && { printf '%s' "$c"; return; }
  done
  command -v ssh 2>/dev/null || printf 'ssh'
}
SSH="$(pick_ssh)"
# 选不出来就当场退出 —— 让它带着「找不到 ssh」死掉，而不是让远端命令
# 被调用方的 `|| true` 静默吞成「远端什么都没有」。
#
# 调用方的 `die` 不一定已经定义好（publish-apk.sh 是先 source 再定义 say/die），
# 所以这里自己兜一个。
if ! command -v "$SSH" >/dev/null 2>&1 && [ ! -x "$SSH" ]; then
  _pf_msg="找不到 ssh（试过 \$SSH、Windows 自带的 ssh.exe、PATH 里的 ssh）。
    显式指定：SSH=/usr/bin/ssh ./deploy/publish-web.sh …"
  if declare -F die >/dev/null 2>&1; then die "$_pf_msg"; else printf '\n!! %s\n' "$_pf_msg" >&2; exit 1; fi
fi

# 取远端的**内容指纹**。
#
# ⚠️ 以前两处都写成 `REMOTE_FP="$(ssh … || true)"` —— `|| true` 会把「ssh 连不上」
#    和「远端目录还不存在」抹成同一个结果：空字符串。而调用方的判断是
#    「指纹不一样 → 有变更 → 发布」，于是 **ssh 坏掉 = 每次都当成有变更**，
#    指纹跳过这条唯一的省事逻辑静默失效。真正的「首发布、远端还没目录」用
#    `__MISSING__` 这个哨兵单独表达，两者不再混为一谈。
#
# 用法：pf_remote_fp <远端目录> <指纹命令>
#   成功且目录在 → 打印指纹
#   成功但目录不在 → 打印 __MISSING__
#   ssh 本身失败 → 当场退出（绝不返回空串让调用方猜）
pf_remote_fp() {
  local dir="$1" cmd="$2" out rc
  out="$("$SSH" "$SSH_HOST" "cd $dir 2>/dev/null && { $cmd; } || echo __MISSING__" 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    local msg="取不到远端指纹：ssh $SSH_HOST 失败（退出码 $rc）。
    ssh 都连不上，就别猜「线上是空的」—— 那会让「无变更 → 跳过」这条逻辑
    静默失效、每次发布都当成有变更。先确认 ssh 能连：ssh $SSH_HOST hostname"
    if declare -F die >/dev/null 2>&1; then die "$msg"; else printf '\n!! %s\n' "$msg" >&2; exit 1; fi
  fi
  printf '%s' "$out"
}

# 备份目录分两类，**必须分开对待**：
#
#   <dir>.bak-<version>-<MMDD-HHMMSS>    发布前的快照 —— 「回滚到上一份」指的就是它
#   <dir>.bak-rollback-<MMDD-HHMMSS>     回滚前的快照 —— 也就是**坏掉的那一版**
#
# ⚠️ 2026-10-25 发现的坑：回滚自己也会写一份 `bak-rollback-*`，而按 mtime
#    「挑最新的一份」时它就是最新 —— **连续回滚两次会把刚退掉的坏版本装回去**。
#    用户以为在「再退一步」，实际在把事故版本请回来，而且第二次的命令与第一次
#    一模一样，看不出任何区别。所以候选里**永远排除 `-rollback-`**；
#    这类快照只留在盘上当「撤销这次回滚」的手动后悔药。
PF_ROLLBACK_TAG='rollback'      # 回滚快照名的中缀，与 source 方拼目录名时共用

# 打印「列出回滚候选」的远端命令（排除回滚快照，按 mtime 新→旧）。
pf_rollback_candidates_cmd() {
  printf "ls -1dt %s.bak-* 2>/dev/null | grep -v -- '-%s-' || true" "$1" "$PF_ROLLBACK_TAG"
}

# 打印「清理旧备份」的远端命令：两类各留 $2 份（`$2` = KEEP）。
pf_prune_backups_cmd() {
  local dir="$1" keep="$2"
  printf "ls -1dt %s.bak-* 2>/dev/null | grep -v -- '-%s-' | tail -n +%d | xargs -r rm -rf\n" \
    "$dir" "$PF_ROLLBACK_TAG" "$((keep + 1))"
  # 回滚快照只在出事故时才产生，留 2 份够「撤一次、再撤一次」。
  printf "ls -1dt %s.bak-* 2>/dev/null | grep -- '-%s-' | tail -n +3 | xargs -r rm -rf" \
    "$dir" "$PF_ROLLBACK_TAG"
}

PF_APPROVE=0
PF_ALLOW_DIRTY=0
PF_ALLOW_UNPUSHED=0
PF_FORCE=0
PF_ROLLBACK=0
PF_SKIP_BUILD=0

# ⚠️ **所有开关都在这里一次扫完，不要再用 `[ "$1" = --xxx ]`**（2026-10-25）。
#
# 事故是这样发生的：`--rollback` / `--skip-build` 原先写成只认 `$1`，而
# `--approve` 是这里 for 循环扫全量的。于是文档里那个自然顺序
# `publish-web.sh --approve --rollback`（`$1` 是 `--approve`）**不进回滚分支**，
# 一路落到「构建 → 比指纹 → 授权通过 → 发布」—— **以为在回滚，实际在发布**，
# 不报错也不提示。判定写在两个地方、规则还不一样，这种错一定会再犯。
#
# 未知的 `--xxx` 直接 die：静默忽略一个开关和「开关失效」是同一种事故。
# 位置参数（如 publish-apk.sh 的更新说明）不以 `--` 开头，不受影响。
pf_parse_args() {
  for a in "$@"; do
    case "$a" in
      --approve)        PF_APPROVE=1;;
      --allow-dirty)    PF_ALLOW_DIRTY=1;;
      --allow-unpushed) PF_ALLOW_UNPUSHED=1;;
      --force)          PF_FORCE=1;;
      --rollback)       PF_ROLLBACK=1;;
      --skip-build)     PF_SKIP_BUILD=1;;
      --*)              die "未知参数：$a（可用：--approve --rollback --force
    --skip-build --allow-dirty --allow-unpushed）";;
    esac
  done
}

# 采集来源工作区的状态。调用前需要在仓库根。
pf_gather() {
  cd "$ROOT"
  PF_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<无>')"
  PF_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '<无>')"
  PF_UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  PF_DIRTY_N="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

  PF_UNPUSHED=0
  PF_BEHIND=0
  PF_FETCH=skip
  if [ -n "$PF_UPSTREAM" ]; then
    # 先拉一次才知道「未推送 / 落后」是不是真的 —— 跟踪引用可能是过期的。
    # 离线时拉不动，下面会提示按本地缓存判断。
    if git fetch --quiet "${PF_UPSTREAM%%/*}" "${PF_UPSTREAM#*/}" 2>/dev/null; then
      PF_FETCH=ok
    else
      PF_FETCH=fail
    fi
    PF_UNPUSHED="$(git rev-list --count "$PF_UPSTREAM..HEAD" 2>/dev/null || echo 0)"
    PF_BEHIND="$(git rev-list --count "HEAD..$PF_UPSTREAM" 2>/dev/null || echo 0)"
  fi

  PF_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
  [ -n "$PF_VERSION" ] || PF_VERSION="unknown"
  # ⚠️ Windows 的 hostname 是 GBK，Git Bash 直接打出来是乱码 —— 转一下。
  #    转不动就原样用（Linux 那边本来就是 ASCII，不会走到 iconv 失败这条路）。
  PF_HOST="$(hostname 2>/dev/null || true)"
  PF_HOST="$(printf '%s' "$PF_HOST" | iconv -f GBK -t UTF-8 2>/dev/null || printf '%s' "$PF_HOST")"
  [ -n "$PF_HOST" ] || PF_HOST="unknown"
}

pf_print_summary() {
  local dest="$1"; shift
  printf '\n\033[1;33m---- 发布前置校验 ----\033[0m\n'
  printf '  来源分支    %s\n' "$PF_BRANCH"
  printf '  提交        %s\n' "$PF_SHA"
  printf '  上游        %s\n' "${PF_UPSTREAM:-<未设置跟踪>}"
  printf '  未提交改动  %s 项\n' "$PF_DIRTY_N"
  printf '  未推送提交  %s 个\n' "$PF_UNPUSHED"
  printf '  落后上游    %s 个\n' "$PF_BEHIND"
  if [ "${PF_FETCH:-skip}" = "fail" ]; then
    printf '  ⚠️ 拉不到远端最新状态（离线？），后两项按本地缓存判断\n'
  fi
  printf '  版本        %s\n' "$PF_VERSION"
  printf '  发布主机    %s\n' "$PF_HOST"
  printf '  目标        %s\n' "$dest"
  if [ "$#" -gt 0 ]; then
    for line in "$@"; do printf '  %s\n' "$line"; done
  fi
}

# ⚠️ 退出码**刻意是 1**：dry-run 意味着「没拿到授权，什么都没发」。
#    返回 0 的话，`a.sh --approve && b.sh` 这种链条里漏写一个 --approve 会
#    被当成成功继续往下跑 —— 那就又变成「自动化绕过你发布」了。
#    这不是错误，只是明确地「没做」。
pf_approve_or_exit() {
  if [ "$PF_APPROVE" != "1" ]; then
    printf '\n\033[1;33m== dry-run 结束（退出码 1：未授权）—— 生产未做任何改动。\033[0m\n'
    printf '  确认上面都对，再加 --approve 重跑。\n'
    exit 1
  fi
}

# 摘要 → 体检 → 授权。授权通过才继续往下跑（才可能写生产）。
pf_gate() {
  local dest="$1"; shift
  pf_print_summary "$dest" "$@"
  pf_approve_or_exit

  [ -n "${PF_UPSTREAM:-}" ] \
    || die "当前分支 $PF_BRANCH 没有上游 —— 线上版本无法追溯。先 git push -u。"
  if [ "$PF_DIRTY_N" != "0" ] && [ "$PF_ALLOW_DIRTY" != "1" ]; then
    die "工作区有 $PF_DIRTY_N 项未提交改动 —— 发出去的产物对不上任何提交。
    先提交，或加 --allow-dirty 明确接受这一点。"
  fi
  if [ "$PF_UNPUSHED" != "0" ] && [ "$PF_ALLOW_UNPUSHED" != "1" ]; then
    die "有 $PF_UNPUSHED 个提交还没推到 $PF_UPSTREAM —— 线上版本追溯不到。
    先 git push，或加 --allow-unpushed。"
  fi
  if [ "$PF_DIRTY_N" != "0" ]; then
    printf '  ⚠️ --allow-dirty：带着 %s 项未提交改动发布\n' "$PF_DIRTY_N"
  fi
  if [ "$PF_UNPUSHED" != "0" ]; then
    printf '  ⚠️ --allow-unpushed：有 %s 个提交未推送\n' "$PF_UNPUSHED"
  fi
}

# 发布后把「线上现在跑的是什么」写到 ~/.local/schedule/state/。
#
# ⚠️ 刻意**不放在 web/ 里**：那是 nginx 的站点根，放进去就等于在
#    https://…/schedule/VERSION 上公开版本号和 commit sha。
#    state/ 不在任何容器挂载里，外面读不到。
pf_write_version() {
  local target="$1" ver="${2:-$PF_VERSION}" note="${3:-}"
  local ts; ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf '%s\n' \
    "target=$target" \
    "version=$ver" \
    "commit=$PF_SHA" \
    "branch=$PF_BRANCH" \
    "published_at=$ts" \
    "published_from=$PF_HOST" \
    "note=$note" \
    | "$SSH" "$SSH_HOST" "mkdir -p ~/.local/schedule/state && cat > ~/.local/schedule/state/$target.version"
  printf '  已记录 → ~/.local/schedule/state/%s.version\n' "$target"
}
