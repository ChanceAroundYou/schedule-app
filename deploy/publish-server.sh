#!/usr/bin/env bash
#
# 发布**后端**到服务器。
#
#   ./deploy/publish-server.sh                  # dry-run（只看不发布）
#   ./deploy/publish-server.sh --approve        # 真的发布
#   ./deploy/publish-server.sh --approve --force        # 不看指纹，强制重发
#   ./deploy/publish-server.sh --rollback --approve     # 回滚到上一份备份
#
# ⚠️ **开关顺序无所谓**（2026-10-25 起）：全部开关统一在 pf_parse_args 里扫全量。
#    别再退回 `[ "$1" = --rollback ]` 的写法 —— 那样 `--approve --rollback`
#    会被当成普通发布（静默上线），见 deploy/preflight.sh 里的说明。
#
# ⚠️ **默认 dry-run**：不加 --approve 就只打印「要发什么、发到哪、来源分支是
#    哪个提交」，**绝不写生产**（不上传、不备份、不重启）。双端开发下生产
#    锁定的那道闸门，见 deploy/preflight.sh。
#
# 做七件事：
#   1. 打包 server/（剔除 data / *.bak / .claude / .omc / tests/），算内容指纹
#   2. 跟远端现有的 server/ 比指纹 —— **一样就什么都不做**（省掉上传、
#      备份、重启，后端不用白断一次）
#   3. 前置校验 + 授权：分支 / HEAD / 干净 / 已推送
#   4. 传到远端临时目录
#   5. 现有版本整份备份成 app.bak-<时间>，保留最近 3 份
#   6. 换掉 server/ 内容 + **按需补 node_modules 软链**（只在它没了/断了时）
#   7. systemctl --user restart + 探活 /api/health + 写 state/app.version
#
# ⚠️ **三个必须知道的坑**（2026-10-15 从 SMB 工程目录挪过来时踩的）：
#
#   1. `node_modules` **是软链，不是重装依赖**。依赖本体在 ~/.local/schedule/deps
#      （112 MB，只在 deploy/install-deps.sh 里装一次），app/node_modules 只是
#      一条指向 ../deps/node_modules 的软链 —— Node 从 server/ 往上找依赖靠它。
#      软链没了服务会崩在 `require('@earendil-works/pi-ai')`，而 restart 之后
#      systemd 会不停重启，看起来像「后端抽风」。
#      所以脚本只在 `[ ! -e node_modules ]` 时才重建它（**-e 对悬空软链是假**，
#      正好覆盖「链还在、指向的目标没了」这种情况）。平时不动它。
#
#   2. **只换目录里的东西，绝不 mv 目录本身** —— 与 publish-web.sh 同一个坑：
#      Docker 的 bind mount 认 inode，目录被 mv 走之后容器里那个挂载点就废了
#      （/data/schedule-app 也挂进了 nginx，虽然线上不读它，但排障时会对不上
#      版本）。实测中过一次 403，重启容器才恢复。
#
#   3. **数据不在被发布的目录里**：SQLite 库和密钥在 ~/.local/schedule/data/
#      （unit 的 SCHEDULE_DATA_DIR），跟代码目录分开。所以拷代码、换目录
#      **不会动到数据**，回滚也只需拷回代码。
#
# 以前服务直接跑 SMB 工程目录里的代码（WorkingDirectory 指向 /mnt/fnos/...），
# 那份目录是你在别的设备也在动的活工作区 —— 别人改一下、线上就跟着变。
# 现在跑的是服务器本机磁盘 ~/.local/schedule/app/ 那份拷贝。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_HOST="${SSH_HOST:-ubuntu}"
# ssh 可执行文件由 preflight.sh 的 pick_ssh() 探测：
#   显式 `SSH=` → Windows 自带的 ssh.exe → PATH 里的 ssh。
# **别在这里再写死某个平台的路径** —— 那样 Linux 侧会静默失败。
# 注意也别在这里给 SSH 赋任何值，会盖掉用户传进来的那个。
REMOTE_APP='~/.local/schedule/app'
KEEP=3

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# shellcheck source=preflight.sh
source "$ROOT/deploy/preflight.sh"
pf_parse_args "$@"

# server/ 的**内容**指纹：逐文件 sha256 再汇总。只看内容、不看 mtime，
# 所以「重新打包了一遍但代码没动」也算一致。
#
# ⚠️ 中间那道 `sed 's/\*//g' | tr -s ' '` 是必需的，别删：
#    Git Bash 的 sha256sum 走**二进制**模式，输出 `HASH *路径`（一个空格 + 星号）；
#    Linux 上是文本模式，输出 `HASH  路径`（两个空格）。两边算同一批文件会得出
#    不同的汇总值，于是指纹永远对不上、跳过逻辑形同虚设（实测踩到过）。
#    抹掉星号 + 压掉连续空格后两边才一致。
FP_CMD="find server -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sed 's/\*//g' | tr -s ' ' | sha256sum | cut -c1-16"

# ---------------------------------------------------------------- 回滚
if [ "$PF_ROLLBACK" = "1" ]; then
  say "回滚：列出备份"
  # ⚠️ 两条判定规则，与 publish-web.sh 一字不差地同源（改一处就要改两处）：
  #    按 **mtime** 挑，且**排除 `-rollback-` 快照** —— 回滚自己也会写一份
  #    这类快照，不排除的话连续回滚两次会把刚退掉的坏版本装回去。
  RUB="$(pf_rollback_candidates_cmd "$REMOTE_APP")"
  LAST="$("$SSH" "$SSH_HOST" "$RUB | head -1")"
  [ -n "$LAST" ] || die "没有找到任何可回滚的备份（$REMOTE_APP.bak-*，已排除 -rollback- 快照）"
  pf_gather
  # 回滚会覆盖线上后端 —— 把候选摆出来，让人有机会发现挑错了。
  echo "  可选备份（按时间新→旧，不含 -rollback- 快照）："
  "$SSH" "$SSH_HOST" "$RUB | head -5 | sed 's/^/    /'" || true
  pf_print_summary "$REMOTE_APP" "动作=回滚到 $LAST"
  pf_approve_or_exit
  printf '  回滚到：%s\n' "$LAST"
  "$SSH" "$SSH_HOST" "set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
mkdir -p $REMOTE_APP
cp -r $REMOTE_APP $REMOTE_APP.bak-rollback-\$(date +%m%d-%H%M%S)
rm -rf $REMOTE_APP/server
cp -r $LAST/server $REMOTE_APP/server
if [ -e $REMOTE_APP/node_modules ]; then echo '    依赖软链 ok'; else ln -sfn ../deps/node_modules $REMOTE_APP/node_modules; fi
systemctl --user restart schedule-backend
sleep 3
systemctl --user is-active schedule-backend"
  pf_write_version app "" "rollback to $(basename "$LAST")"
  say "回滚完成，探活（探的是服务器上的 127.0.0.1，不是本机）"
  "$SSH" "$SSH_HOST" "curl -s --noproxy '*' http://127.0.0.1:25692/api/health"
  exit 0
fi

# ---------------------------------------------------------------- 打包
say "1/7 打包 server/（剔除 data / *.bak / .claude / .omc / tests）"
cd "$ROOT"
[ -d server ] || die "找不到 server/ —— 在仓库根目录跑这个脚本"
rm -rf /tmp/schedule-server-stage
mkdir -p /tmp/schedule-server-stage
tar -czf /tmp/schedule-server.tgz \
  --exclude='server/data' --exclude='server/tests' \
  --exclude='.claude' --exclude='.omc' --exclude='*.bak*' \
  server
tar -xzf /tmp/schedule-server.tgz -C /tmp/schedule-server-stage
printf '  打包内容：\n'
ls /tmp/schedule-server-stage/server | sed 's/^/    /'

# ---------------------------------------------------------------- 指纹比对
say "2/7 跟远端比内容指纹"
LOCAL_FP="$(cd /tmp/schedule-server-stage && eval "$FP_CMD")"
REMOTE_FP="$(pf_remote_fp "$REMOTE_APP" "$FP_CMD")"
REMOTE_SHOW="$REMOTE_FP"
[ "$REMOTE_FP" = "__MISSING__" ] && REMOTE_SHOW='<远端还没有这个目录，首次发布>'
printf '  本地 %s\n  远端 %s\n' "${LOCAL_FP:-<空>}" "$REMOTE_SHOW"

SKIP=0
if [ "$PF_FORCE" = "0" ] && [ -n "$LOCAL_FP" ] && [ "$LOCAL_FP" = "$REMOTE_FP" ]; then
  SKIP=1
else
  [ "$PF_FORCE" = "1" ] && printf '  --force：跳过比对，照发\n'
fi

# ---------------------------------------------------------------- 授权闸门
pf_gather
if [ "$SKIP" = "1" ]; then
  say "无变更 → 不上传 / 不备份 / 不重启"
  pf_print_summary "$REMOTE_APP" "内容指纹一致，本次不会改动生产"
else
  say "3/7 前置校验 + 授权"
  pf_gate "$REMOTE_APP" \
    "内容指纹  远端与本地不同，将整份替换 server/" \
    "副作用    会 systemctl --user restart schedule-backend（后端中断几秒）"
fi

if [ "$SKIP" = "1" ]; then
  "$SSH" "$SSH_HOST" "set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
printf '  服务状态  %s\\n' \"\$(systemctl --user is-active schedule-backend)\"
if [ -e $REMOTE_APP/node_modules ]; then echo '  依赖软链  ok'; else echo '  ⚠️ 依赖软链缺失/悬空（本次无变更，不会改生产）'; fi
printf '  /api/health -> %s\\n' \"\$(curl -s --noproxy '*' http://127.0.0.1:25692/api/health)\""
  rm -f /tmp/schedule-server.tgz
  rm -rf /tmp/schedule-server-stage
  printf '\n  要强制重发一遍：./deploy/publish-server.sh --approve --force\n'
  exit 0
fi

# ---------------------------------------------------------------- 上传
say "4/7 传到远端临时目录"
"$SSH" "$SSH_HOST" "rm -rf $REMOTE_APP.new && mkdir -p $REMOTE_APP.new"
tar -czf - -C /tmp/schedule-server-stage server \
  | "$SSH" "$SSH_HOST" "tar -xzf - -C $REMOTE_APP.new && echo '    解包 ok'"

# ---------------------------------------------------------------- 备份 + 切换
say "5/7 备份现有版本 → 切换"
TS="$(date +%m%d-%H%M%S)"
"$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_APP
if [ -f $REMOTE_APP/server/server.js ]; then
  cp -r $REMOTE_APP $REMOTE_APP.bak-$TS
  echo \"    已备份 app.bak-$TS\"
fi
rm -rf $REMOTE_APP/server
cp -r $REMOTE_APP.new/server $REMOTE_APP/server
rm -rf $REMOTE_APP.new
# ⚠️ 这条软链是命根子，但**平时不动** —— 只有不存在或悬空时才重建
if [ -e $REMOTE_APP/node_modules ]; then
  echo '    依赖软链已存在，跳过'
else
  ln -sfn ../deps/node_modules $REMOTE_APP/node_modules
  echo '    依赖软链缺失/悬空，已重建'
fi
# 保留策略与回滚挑选**同源**（pf_prune_backups_cmd）：按 mtime、`-rollback-` 单独计。
$(pf_prune_backups_cmd "$REMOTE_APP" "$KEEP")
echo '    软链：'; ls -l $REMOTE_APP/node_modules | sed 's/^/    /'"

# ---------------------------------------------------------------- 重启
say "6/7 重启后端"
"$SSH" "$SSH_HOST" "set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
systemctl --user daemon-reload
systemctl --user restart schedule-backend
sleep 3
systemctl --user is-active schedule-backend"

# ---------------------------------------------------------------- 校验
say "7/7 探活 + 看日志"
HEALTH="$("$SSH" "$SSH_HOST" "curl -s --noproxy '*' http://127.0.0.1:25692/api/health" || true)"
printf '  /api/health -> %s\n' "$HEALTH"
printf '%s' "$HEALTH" | grep -q '"ok":true' || die "后端没起来，看日志：journalctl --user -u schedule-backend -n 50"
"$SSH" "$SSH_HOST" "journalctl --user -u schedule-backend -n 6 --no-pager | sed 's/^/    /'"

pf_write_version app
rm -f /tmp/schedule-server.tgz
rm -rf /tmp/schedule-server-stage
say "发布完成"
printf '  回滚：./deploy/publish-server.sh --rollback --approve\n'
