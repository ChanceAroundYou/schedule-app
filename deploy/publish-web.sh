#!/usr/bin/env bash
#
# 发布**网页版**前端到服务器。
#
#   ./deploy/publish-web.sh                    # 构建 + dry-run（只看不发布）
#   ./deploy/publish-web.sh --approve          # 构建 + 真的发布
#   ./deploy/publish-web.sh --approve --skip-build # 已有 dist/，不再构建
#   ./deploy/publish-web.sh --approve --force  # 不看指纹，强制重发
#   ./deploy/publish-web.sh --rollback --approve # 回滚到上一份备份
#
# ⚠️ **开关顺序无所谓**（2026-10-25 起）：全部开关统一在 pf_parse_args 里扫全量。
#    以前 `--rollback` / `--skip-build` 只认 `$1`，而 `--approve` 扫全量 ——
#    于是 `--approve --rollback` **不进回滚分支**，一路走到「发布」，
#    以为在回滚实际在上线，还不报错。别再退回 `[ "$1" = ... ]` 的写法。
#
# ⚠️ **默认 dry-run**：不加 --approve 就只打印「要发什么、发到哪、来源分支是
#    哪个提交」，**绝不写生产**。这是双端开发下生产锁定的那道闸门 ——
#    任何自动化（定时器、批量操作）都不会越过你发出去。
#
# 做六件事：
#   1. 本地 `npm run build`（**同源**，不带 VITE_API_BASE —— 那是 APK 用的）
#   2. 跟线上的 web/ 比内容指纹 —— **一样就不上传、不备份、不切换**
#   3. 前置校验 + 授权（deploy/preflight.sh）：分支 / HEAD / 干净 / 已推送
#   4. tar 管道传到远端**临时目录**（不是直接盖当前版本，避免传一半被读到）
#   5. 现有版本整份备份成 web.bak-<版本>-<时间>，保留最近 3 份
#   6. 换掉目录内容 + 回读校验 + 写 state/web.version
#
# ⚠️ **为什么要有这个脚本**（2026-10-15）：
# 以前 nginx 把整个 SMB 工程目录挂成 /data/schedule、alias 指向它的 dist/，
# 于是「本地 build 一下覆盖 SMB 那份」**就等于上线** —— 构建产物落在多设备共享
# 的源码目录里，没有发布动作、没有备份、没有回滚，而且那份目录你在别的设备
# 上也一直在动。现在前端产物在服务器本机磁盘 ~/.local/schedule/web/，
# 工程里的 dist/ 只是本地产物，**发布必须显式跑这个脚本 + 显式 --approve**。
#
# 回滚不用 git：备份就在同层目录，服务器本机磁盘，拷回去是秒级。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"

SSH_HOST="${SSH_HOST:-ubuntu}"
# 必须用 Windows 自带的 ssh.exe —— Git Bash 的 MSYS 版不读 ~/.ssh/config 里的别名
# ssh 可执行文件由 preflight.sh 的 pick_ssh() 探测：
#   显式 `SSH=` → Windows 自带的 ssh.exe → PATH 里的 ssh。
# **别在这里再写死某个平台的路径** —— 那样 Linux 侧会静默失败。
# 注意也别在这里给 SSH 赋任何值，会盖掉用户传进来的那个。
REMOTE_WEB='~/.local/schedule/web'
BASE_URL="${BASE_URL:-https://home.xiaokubao.space/schedule}"
KEEP=3

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# shellcheck source=preflight.sh
source "$ROOT/deploy/preflight.sh"
pf_parse_args "$@"

# dist 的**内容**指纹：逐文件 sha256 再汇总。只看内容、不看 mtime。
#
# ⚠️ 中间那道 `sed 's/\*//g' | tr -s ' '` 是必需的，别删：Git Bash 的 sha256sum
#    走二进制模式输出 `HASH *路径`，Linux 上是文本模式输出 `HASH  路径`，
#    不归一化的话两边永远对不上（publish-server.sh 里踩过）。
FP_CMD="find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sed 's/\*//g' | tr -s ' ' | sha256sum | cut -c1-16"

# ---------------------------------------------------------------- 回滚
if [ "$PF_ROLLBACK" = "1" ]; then
  say "回滚：列出备份"
  # ⚠️ 两条判定规则，缺一条就出事故（2026-10-25）：
  #
  # ① **按 mtime 挑，不能按名字字典序。** 备份名有三种格式，字典序和时间序
  #    不是一回事：`<version>-<MMDD>` 里 version 也参与排序（`2.1.9` 排在
  #    `2.1.10` 后面）、`prod-<YYYYMMDD>` 是迁移留下的、`rollback-<MMDD>` 是
  #    回滚自己写的。原来写 `ls -1d … | sort | tail -1`：实机上选中的是
  #    **2026-10-15 的 `prod`** 那份，比最近的备份旧了一周多。
  #
  # ② **必须排除 `-rollback-` 快照。** 回滚时自己也会写一份 `bak-rollback-*`，
  #    它按 mtime 就是最新的 —— 不排除的话**连续回滚两次会把刚退掉的坏版本
  #    装回去**。第二次的命令和第一次一字不差，用户不可能看出区别。
  #    这类快照只当「撤销这次回滚」的手动后悔药，留在盘上但不参与挑选。
  RUB="$(pf_rollback_candidates_cmd "$REMOTE_WEB")"
  LAST="$("$SSH" "$SSH_HOST" "$RUB | head -1")"
  [ -n "$LAST" ] || die "没有找到任何可回滚的备份（$REMOTE_WEB.bak-*，已排除 -rollback- 快照）"
  pf_gather
  # 回滚不可撤销地覆盖线上内容 —— 把候选摆出来，让人有机会发现挑错了。
  echo "  可选备份（按时间新→旧，不含 -rollback- 快照）："
  "$SSH" "$SSH_HOST" "$RUB | head -5 | sed 's/^/    /'" || true
  echo "  ⚠️ 想撤销「上一次回滚」，把 -rollback- 那份手动拷回来："
  "$SSH" "$SSH_HOST" "ls -1dt $REMOTE_WEB.bak-rollback-* 2>/dev/null | head -1 | sed 's/^/    /'" || true
  pf_print_summary "$REMOTE_WEB" "动作=回滚到 $LAST"
  pf_approve_or_exit
  printf '  回滚到：%s\n' "$LAST"
  # 同样**不能 mv 目录**（bind mount 认 inode），只把内容拷回去
  # 回滚前的现场也留一份：这次回滚本身也可能是错的，得能再退回来。
  "$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_WEB
cp -r $REMOTE_WEB $REMOTE_WEB.bak-rollback-$(date +%m%d-%H%M%S)
rm -rf $REMOTE_WEB/*
cp -r $LAST/. $REMOTE_WEB/"
  pf_write_version web "" "rollback to $(basename "$LAST")"
  say "回滚完成，回读校验"
  curl -s --noproxy '*' -o /dev/null -w '  index=%{http_code}\n' "$BASE_URL/"
  exit 0
fi

# ---------------------------------------------------------------- 构建
if [ "$PF_SKIP_BUILD" = "1" ]; then
  say "1/6 跳过构建（--skip-build），用现有 dist/"
else
  say "1/6 本地构建（同源，不带 VITE_API_BASE）"
  cd "$APP"
  npm run build
fi
cd "$ROOT"
[ -f dist/index.html ] || die "没有 dist/index.html —— 先构建"
[ -d dist/assets ] || die "dist/assets 不存在"

# 版本写进备份名，便于「回滚到哪个版本」有据可依。
# 用 grep 而不是 `node -p require(...)`：这里是 Windows 的 node，
# require('/c/Users/...') 这种 Git Bash 路径它解析不了。
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP/package.json" | head -1)"
[ -n "$VERSION" ] || VERSION="unknown"
TS="$(date +%m%d-%H%M%S)"

# ---------------------------------------------------------------- 指纹比对
say "2/6 跟线上比内容指纹"
LOCAL_FP="$(cd dist && eval "$FP_CMD")"
REMOTE_FP="$(pf_remote_fp "$REMOTE_WEB" "$FP_CMD")"
REMOTE_SHOW="$REMOTE_FP"
[ "$REMOTE_FP" = "__MISSING__" ] && REMOTE_SHOW='<远端还没有这个目录，首次发布>'
printf '  本地 %s\n  线上 %s\n' "${LOCAL_FP:-<空>}" "$REMOTE_SHOW"
SKIP=0
if [ "$PF_FORCE" = "0" ] && [ -n "$LOCAL_FP" ] && [ "$LOCAL_FP" = "$REMOTE_FP" ]; then
  SKIP=1
else
  [ "$PF_FORCE" = "1" ] && printf '  --force：跳过比对，照发\n'
fi

# ---------------------------------------------------------------- 授权闸门
pf_gather
if [ "$SKIP" = "1" ]; then
  # 线上已经是这份内容 —— 不会写生产，所以不需要授权，但仍然把来源状态摆出来
  say "无变更 → 不上传 / 不备份 / 不切换"
  pf_print_summary "$REMOTE_WEB" "内容指纹一致，本次不会改动生产"
else
  say "3/6 前置校验 + 授权"
  pf_gate "$REMOTE_WEB" \
    "内容指纹  线上与本地不同，将整份替换" \
    "备份      将在服务器上留 web.bak-$VERSION-$TS（保留最近 $KEEP 份）"
fi

# ---------------------------------------------------------------- 上传
if [ "$SKIP" = "0" ]; then
say "4/6 传到远端临时目录"
# ⚠️ **模式必须在这里归一次**（2026-10-24 P3）：工程目录在 CIFS 上，`dist/` 里的
# 文件和目录出来就是 `055` —— tar 照原样带过去，远端解包时先建出 `assets/`（`r-x`，
# **没有写位**）再往里塞文件就 `Permission denied`，`cp -r` 也读不动。
# 以前每次靠手动 `chmod -R 755` 补救。现在三层各挡一次：
#   · 本地尽力 chmod（CIFS 上可能是空操作，所以只当 best effort）
#   · 打包时强制写进归档头（`--mode`，解包端照这个建）
#   · 解包后再 chmod 一次 + 数一遍文件数（少文件 = 解包被截断，当场报）
chmod -R u+rwX dist 2>/dev/null || true
"$SSH" "$SSH_HOST" "rm -rf $REMOTE_WEB.new && mkdir -p $REMOTE_WEB.new"
LOCAL_N="$(find dist -type f | wc -l | tr -d ' ')"
tar -czf - -C dist --mode='u+rwX,go+rX' . \
  | "$SSH" "$SSH_HOST" "set -e
tar -xzf - -C $REMOTE_WEB.new
chmod -R u+rwX,go+rX $REMOTE_WEB.new
N=\$(find $REMOTE_WEB.new -type f | wc -l)
[ \"\$N\" = \"$LOCAL_N\" ] || { echo \"    !! 解包后只有 \$N 个文件，本地是 $LOCAL_N 个\" >&2; exit 1; }
echo '    解包 ok（'\$N' 个文件，模式已归一成 u+rwX,go+rX）'"

# ---------------------------------------------------------------- 备份 + 切换
say "5/6 备份现有版本 → 切换"
# ⚠️ **只换目录里的东西，绝不 mv 目录本身**（2026-10-15 实测踩的）：
# Docker 的 bind mount 认的是 **inode**。把目录 mv 走、再把新目录 mv 上来，
# 容器里那个挂载点还指着旧 inode —— 而旧目录已经被删了，于是 nginx 立刻 403
# `directory index of "/data/schedule-web/" is forbidden`，而且**重启容器前
# 不会自愈**。所以目标目录的 inode 从建好那天起就不能变。
#
# ⚠️⚠️ 下面这个 ssh 参数是**双引号串**：引号内除了 $VAR 与 \" 转义，**不能出现
# 反引号**（会被本地当命令替换执行）、不能有裸的 $（会被本地展开）。2026-10-25
# 就在这儿炸过：有人在串内注释里给 -rollback- 加了一对反引号做行内代码，bash
# 去执行那个词并报 command not found，整条 ssh 命令根本没发出去，发布静默停在
# 5/6 却报「发布失败」。串内注释请写纯文本。
"$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_WEB
if [ -f $REMOTE_WEB/index.html ]; then
  cp -r $REMOTE_WEB $REMOTE_WEB.bak-$VERSION-$TS
  echo \"    已备份 web.bak-$VERSION-$TS\"
fi
rm -rf $REMOTE_WEB/*
cp -r $REMOTE_WEB.new/. $REMOTE_WEB/
rm -rf $REMOTE_WEB.new
# 只留最近 N 份（两类分开计，普通快照与回滚快照互不挤占）。
# 按 **mtime** 排、并区分 -rollback-：备份名有 <version>-<MMDD> /
# prod-<YYYYMMDD> / rollback-<MMDD> 三种格式，字典序会把最老的当成最新的
# 留下来，删掉的正好是刚发的那几份。回滚挑的就是这批目录，两处必须同一口径。
$(pf_prune_backups_cmd "$REMOTE_WEB" "$KEEP")
ls -1dt $REMOTE_WEB.bak-* 2>/dev/null | sed 's/^/    /' || true"
fi

# ---------------------------------------------------------------- 校验
say "6/6 回读校验"
LOCAL_HASHES="$(grep -o 'index-[A-Za-z0-9_-]*\.\(js\|css\)' dist/index.html | sort)"
printf '  本地 index.html 引用：\n%s\n' "$(printf '%s' "$LOCAL_HASHES" | sed 's/^/    /')"

# ⚠️ **先跟服务器磁盘上那一份比**（2026-10-24 P3）。以前只从公网抓 HTML 再 grep，
# 于是「线上已经是新 hash、公网那份还是旧的」也报「发布可能没生效」—— 假阴性，
# 每次都得手动 `grep` 一遍才知道到底成没成。服务器那份才是真相，
# 公网那一趟降级成链路体检（不一致只提示，不判定失败）。
REMOTE_HASHES="$("$SSH" "$SSH_HOST" "grep -o 'index-[A-Za-z0-9_-]*\.\(js\|css\)' $REMOTE_WEB/index.html 2>/dev/null | sort" || true)"
[ "$REMOTE_HASHES" = "$LOCAL_HASHES" ] || die "服务器上的 web/index.html 引用的还是旧 hash
    线上 $REMOTE_WEB/index.html → $(printf '%s' "${REMOTE_HASHES:-<读不到文件>}" | tr '\n' ' ')
    本地 dist/index.html      → $(printf '%s' "$LOCAL_HASHES" | tr '\n' ' ')
    —— 第 4 / 5 步（解包、备份、切换）里有一步没落地，往上翻它的输出"
printf '  ✓ 服务器那份引用的 hash 与本地一致\n'

CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE_URL/")"
[ "$CODE" = "200" ] || die "线上首页返回 $CODE"
ONLINE="$(curl -s --noproxy '*' "$BASE_URL/")"
for h in $LOCAL_HASHES; do
  printf '%s' "$ONLINE" | grep -q "$h" \
    || printf '  ⚠️ 公网那份 index.html 里没有 %s（反代或 CDN 缓存？服务器侧已核对过）\n' "$h"
done
for h in $LOCAL_HASHES; do
  C="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE_URL/assets/$h")"
  [ "$C" = "200" ] || die "$h 下载返回 $C"
  printf '    %s -> HTTP %s\n' "$h" "$C"
done

if [ "$SKIP" = "0" ]; then
  pf_write_version web "$VERSION"
  say "发布完成（$VERSION）"
else
  say "未改动生产（线上已是这份内容）"
fi
printf '  回滚：./deploy/publish-web.sh --rollback --approve\n'
# 用户端要不要清缓存？**不用**（2026-10-24 P3 记在这儿，免得每次发布都问一遍）：
# `app/public/sw.js`（sched-shell-v4）对导航请求走「网络优先、断了才回落缓存」，
# 只有带内容哈希的 assets 是缓存优先；`app/src/data/update-guard.ts` 还会比 bundle 名，
# 不一致就提示刷新。真看到旧界面时的排查顺序：硬刷新 → 看 SW 是不是旧代
# （activate 只删 `sched-shell-*` 里不是当前 CACHE 的那些）→ 手动注销 SW 并清 `sched-shell-*`。
printf '  用户端不用清缓存（导航网络优先）；还看到旧界面：硬刷新 → 注销 SW\n'
