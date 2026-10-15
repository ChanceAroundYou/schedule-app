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
# 依赖调用方已定义：ROOT、SSH、SSH_HOST

PF_APPROVE=0
PF_ALLOW_DIRTY=0
PF_ALLOW_UNPUSHED=0
PF_FORCE=0

pf_parse_args() {
  for a in "$@"; do
    case "$a" in
      --approve)        PF_APPROVE=1;;
      --allow-dirty)    PF_ALLOW_DIRTY=1;;
      --allow-unpushed) PF_ALLOW_UNPUSHED=1;;
      --force)          PF_FORCE=1;;
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
