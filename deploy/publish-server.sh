#!/usr/bin/env bash
#
# 发布**后端**到服务器。
#
#   ./deploy/publish-server.sh            # 拷代码 + 备份 + restart + 探活
#   ./deploy/publish-server.sh --rollback # 回滚到上一份备份
#
# 做五件事：
#   1. 把工程里的 server/ 打包（剔除 data/ *.bak .claude .omc tests/）
#   2. 传到远端**临时目录**
#   3. 现有版本整份备份成 schedule-app.bak-<时间>，保留最近 3 份
#   4. mv 到位 + **重建 node_modules 软链**（缺了服务起不来，见下）
#   5. systemctl --user restart + 探活 /api/health + 看最近日志
#
# ⚠️ **两个必须知道的坑**（2026-10-15 从 SMB 工程目录挪过来时踩的）：
#
#   1. `node_modules` 软链：工程里根 node_modules 是软链到
#      ~/.local/share/schedule-deps/node_modules 的，Node 从 server/ 往上找
#      依赖就靠它。新目录里没有这条软链的话，服务会直接崩在
#      `require('@earendil-works/pi-ai')` —— 而 restart 之后 systemd 会不停
#      重启，看起来像「后端抽风」。脚本每次都会重建它。
#
#   2. **数据不在被发布的目录里**：SQLite 库和密钥在 ~/.local/share/schedule/
#      （unit 的 SCHEDULE_DATA_DIR），跟代码目录是分开的。所以拷代码、换目录
#      **不会动到数据**，回滚也只需拷回代码。
#
# 以前服务直接跑 SMB 工程目录里的代码（WorkingDirectory 指向 /mnt/fnos/...），
# 那份目录是你在别的设备也在动的活工作区 —— 别人改一下、线上就跟着变。
# 现在跑的是本机磁盘 ~/.local/share/schedule-app/ 那份拷贝。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_HOST="${SSH_HOST:-ubuntu}"
SSH="${SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REMOTE_APP='~/.local/share/schedule-app'
KEEP=3

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 回滚
if [ "${1:-}" = "--rollback" ]; then
  say "回滚：列出备份"
  LAST="$("$SSH" "$SSH_HOST" "ls -1d $REMOTE_APP.bak-* 2>/dev/null | sort | tail -1")"
  [ -n "$LAST" ] || die "没有找到任何备份（$REMOTE_APP.bak-*）"
  printf '  回滚到：%s\n' "$LAST"
  "$SSH" "$SSH_HOST" "set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
mkdir -p $REMOTE_APP
cp -r $REMOTE_APP $REMOTE_APP.bak-rollback-\$(date +%m%d-%H%M%S)
rm -rf $REMOTE_APP/server
cp -r $LAST/server $REMOTE_APP/server
ln -sfn ../schedule-deps/node_modules $REMOTE_APP/node_modules
systemctl --user restart schedule-backend
sleep 3
systemctl --user is-active schedule-backend"
  say "回滚完成，探活（探的是服务器上的 127.0.0.1，不是本机）"
  "$SSH" "$SSH_HOST" "curl -s --noproxy '*' http://127.0.0.1:25692/api/health"
  exit 0
fi

# ---------------------------------------------------------------- 打包
say "1/5 打包 server/（剔除 data / *.bak / .claude / .omc / tests）"
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

# ---------------------------------------------------------------- 上传
say "2/5 传到远端临时目录"
"$SSH" "$SSH_HOST" "rm -rf $REMOTE_APP.new && mkdir -p $REMOTE_APP.new"
tar -czf - -C /tmp/schedule-server-stage server \
  | "$SSH" "$SSH_HOST" "tar -xzf - -C $REMOTE_APP.new && echo '    解包 ok'"

# ---------------------------------------------------------------- 备份 + 切换
say "3/5 备份现有版本 → 切换"
TS="$(date +%m%d-%H%M%S)"
# ⚠️ **只换目录里的东西，绝不 mv 目录本身** —— 与 publish-web.sh 同一个坑：
# Docker 的 bind mount 认 inode，目录被 mv 走之后容器里那个挂载点就废了
# （/data/schedule-app 也挂进了 nginx，虽然线上不读它，但排障时会对不上版本）。
"$SSH" "$SSH_HOST" "set -e
mkdir -p $REMOTE_APP
if [ -f $REMOTE_APP/server/server.js ]; then
  cp -r $REMOTE_APP $REMOTE_APP.bak-$TS
  echo \"    已备份 schedule-app.bak-$TS\"
fi
rm -rf $REMOTE_APP/server
cp -r $REMOTE_APP.new/server $REMOTE_APP/server
rm -rf $REMOTE_APP.new
# ⚠️ 这条软链是命根子：Node 从 server/ 往上找依赖靠它
ln -sfn ../schedule-deps/node_modules $REMOTE_APP/node_modules
ls -1d $REMOTE_APP.bak-* 2>/dev/null | sort | head -n -$KEEP | while read -r d; do rm -rf \"\$d\"; echo \"    清掉旧备份 \$(basename \$d)\"; done
echo '    软链：'; ls -l $REMOTE_APP/node_modules | sed 's/^/    /'"

# ---------------------------------------------------------------- 重启
say "4/5 重启后端"
"$SSH" "$SSH_HOST" "set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
systemctl --user daemon-reload
systemctl --user restart schedule-backend
sleep 3
systemctl --user is-active schedule-backend"

# ---------------------------------------------------------------- 校验
say "5/5 探活 + 看日志"
HEALTH="$("$SSH" "$SSH_HOST" "curl -s --noproxy '*' http://127.0.0.1:25692/api/health" || true)"
printf '  /api/health -> %s\n' "$HEALTH"
printf '%s' "$HEALTH" | grep -q '"ok":true' || die "后端没起来，看日志：journalctl --user -u schedule-backend -n 50"
"$SSH" "$SSH_HOST" "journalctl --user -u schedule-backend -n 6 --no-pager | sed 's/^/    /'"

rm -f /tmp/schedule-server.tgz
rm -rf /tmp/schedule-server-stage
say "发布完成"
printf '  回滚：./deploy/publish-server.sh --rollback\n'
