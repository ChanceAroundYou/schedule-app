#!/usr/bin/env bash
#
# web-loop.sh —— 网页端「改完 → 上线 → 线上实测」的一键闭环
#
#   ./deploy/web-loop.sh            # 全套：类型检查 → 单测 → 本地深测 → 发布 → 线上实测
#   ./deploy/web-loop.sh --fast     # 跳过本地深测（browser-smoke，约 2~3 分钟）
#   ./deploy/web-loop.sh --no-publish   # 只测不发（本地全测 + 线上实测现状）
#   ./deploy/web-loop.sh --server-only  # 只发服务端（例如只改了 server/）
#
# 为什么要有这个（用户 2026-10-17 明确要求）：
#   「把工作流改成自动发布更新，否则根本看不到变化」——
#   改完不再问「要不要发」，默认**直接发到网页端**，然后用 Playwright
#   打生产 URL 实测一遍。任何一步失败 → 退出码非 0，由调用方（Agent）
#   自动返工，修完再跑本脚本。
#
# 分工：网页端 + 服务端归本脚本；**手机端（APK）由另一个会话负责**，这里不碰。
#
# 安全边界（不是可选项）：
#   · 发布路径（app/src、server 等）里有**未提交改动**时直接拒发 ——
#     线上必须能追溯回某个提交。deploy/ 下的草稿脚本不算（不随发布上传）。
#   · 单测/类型检查/本地深测任一失败 → 不发布。
#   · 两个发布脚本自带指纹比对，内容没变会自动跳过（幂等，可反复跑）。
#
set -uo pipefail   # 不用 -e：要逐段检查、给出清晰结论，而不是中途静默退出

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
NO_PUBLISH=0
SERVER_ONLY=0
for a in "$@"; do
  case "$a" in
    --fast)        FAST=1;;
    --no-publish)  NO_PUBLISH=1;;
    --server-only) SERVER_ONLY=1;;
    *) echo "未知参数：$a" >&2; exit 2;;
  esac
done

FAILED=()

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { FAILED+=("$1"); printf '\033[31m   ✗ %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. 前置：可追溯
step "1/5 可追溯性检查（发布路径不能有未提交改动）"
# 只看**会影响发布产物**的路径：网页 = app/src + app/index.html，
# 服务端 = server/。app/android/ 不在此列（手机端是另一个会话的活，跟网页产物无关）。
# deploy/ 下的草稿脚本也不在此列（不随发布上传）。
DIRTY="$(git status --porcelain | awk '{print $2}' \
  | grep -E '^(app/src/|app/index\.html|app/tests/|server/|package(-lock)?\.json$|app/package(-lock)?\.json$)' || true)"
if [ -n "$DIRTY" ]; then
  echo "  发布路径里有未提交改动："
  echo "$DIRTY" | sed 's/^/    /'
  fail "先提交再发（线上要能追溯回某个提交）"
  echo ""
  echo "== 闭环中止：先 commit（deploy/ 下的草稿脚本不影响这里）"
  exit 1
fi
echo "  ok  发布路径干净"

# ---------------------------------------------------------------- 2. 类型检查
step "2/5 类型检查（tsc）"
if ( cd app && npx tsc --noEmit ); then
  echo "  ok  tsc 0 错"
else
  fail "typecheck 失败"
fi

# ---------------------------------------------------------------- 3. 单测
step "3/5 单测（app + server）"
APP_T="$( cd app && node --disable-warning=ExperimentalWarning --test "src/**/*.test.ts" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ' )"
echo "  app:    $APP_T"
echo "$APP_T" | grep -q 'fail 0' || fail "app 单测有失败"

SRV_T="$(node --disable-warning=ExperimentalWarning --test "server/tests/*.test.js" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ')"
echo "  server: $SRV_T"
echo "$SRV_T" | grep -q 'fail 0' || fail "server 单测有失败"

# ---------------------------------------------------------------- 4. 本地深测
if [ "$FAST" = "0" ]; then
  step "4/5 本地深测（browser-smoke：临时库 + 临时后端 + 真实 Chrome）"
  # dist 必须是同源版（APK 的注基址变体会残留，先重建）
  ( cd app && npx vite build >/dev/null 2>&1 )
  # 端口默认自动让开，并行跑也不打架
  if CHROME="${CHROME:-C:/Program Files/Google/Chrome/Application/chrome.exe}" \
     node app/tests/browser-smoke.mjs > /tmp/smoke.log 2>&1; then
    echo "  ok  探针全节通过（$(grep -c '  ok  ' /tmp/smoke.log) 条断言）"
  else
    fail "本地深测失败（详见 /tmp/smoke.log）"
    tail -25 /tmp/smoke.log | sed 's/^/    /'
  fi
else
  step "4/5 本地深测：--fast 跳过"
fi

# ---------------------------------------------------------------- 5. 发布 + 实测
if [ "$NO_PUBLISH" = "1" ]; then
  step "5/5 发布：--no-publish 跳过，只做线上实测"
else
  step "5/5a 发布服务端（内容没变会自动跳过）"
  if bash deploy/publish-server.sh --approve --allow-dirty > /tmp/pub-server.log 2>&1; then
    grep -E "指纹相同|发布完成|已记录" /tmp/pub-server.log | sed 's/^/  /'
    grep -q "指纹相同" /tmp/pub-server.log && echo "  ok  服务端没变，跳过"
  else
    fail "服务端发布失败（详见 /tmp/pub-server.log）"
    tail -20 /tmp/pub-server.log | sed 's/^/    /'
  fi

  if [ "$SERVER_ONLY" = "0" ]; then
    step "5/5b 发布网页端（内容没变会自动跳过）"
    if bash deploy/publish-web.sh --approve --allow-dirty > /tmp/pub-web.log 2>&1; then
      grep -E "指纹相同|发布完成|回读" /tmp/pub-web.log | sed 's/^/  /'
    else
      fail "网页端发布失败（详见 /tmp/pub-web.log）"
      tail -20 /tmp/pub-web.log | sed 's/^/    /'
    fi
  fi
fi

step "线上实测（live-check：Playwright 打生产 URL）"
if node app/tests/live-check.mjs 2>&1 | sed 's/^/  /' | tee /tmp/live.log | grep -q "全通过"; then
  echo "  ok  线上实测全过"
else
  fail "线上实测未通过（详见 /tmp/live.log）"
fi

# ---------------------------------------------------------------- 结论
echo ""
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\033[31m== 闭环未通过（%d 项）\033[0m\n' "${#FAILED[@]}"
  for f in "${FAILED[@]}"; do echo "  ✗ $f"; done
  echo ""
  echo "下一步：按上面的失败项修 → 提交 → 重跑 ./deploy/web-loop.sh"
  exit 1
fi
printf '\033[32m== 闭环通过：已上线并线上实测确认\033[0m\n'
