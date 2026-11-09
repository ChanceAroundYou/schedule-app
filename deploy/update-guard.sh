#!/usr/bin/env bash
#
# update-guard.sh —— **自更新链路守护**（watchdog）
#
#   ./deploy/update-guard.sh                 # 体检线上自更新链路，不通过 → 退出码 1
#   BASE_URL=... API_BASE=... ./deploy/update-guard.sh
#
# 为什么要有它（2026-11-09 两连回归）：
#   · 127~129 发版时把「网页同源版」资源打进 APK，装上后 /api/ 落到 https://localhost，
#     红条「服务器返回了非 JSON 内容」；发布脚本当时只看本地内置目录，看不见线上包。
#   · 更早的 DownloadProvider 私有目录拒绝，让下载任务当场作废，客户端却空转 -1%。
#   两次都是「发布脚本全绿、用户更新到坏包」。所以守护必须**站在客户端那一侧**，
#   把线上当成一个真的 App：拉清单 → 下包 → 校 sha → 解包看内置资源。
#
# 检查项（任一失败即退出 1，fail-closed）：
#   1. version.json 字段齐全合法（versionCode / versionName / url / sha256）
#   2. url 不带路径穿越；清单里的版本号要在 url 里能找到（防清单指向旧包）
#   3. 线上 APK 能下下来、非空
#   4. **线上包的 sha256 与清单一致** —— 这一条同时证明上传没截断、且就是本地
#      publish-apk.sh 用 aapt / apksigner 验过的同一份字节
#   5. 线上包能当 zip 打开，assets/public/index.html 与 js 都在
#   6. **内置 JS 带绝对接口基址**（不是同源版）—— 堵住 127~129 那次回归
#   7. 线上 versionCode 不低于本地 build.gradle（只提示，不判失败：开发中可领先）
#
# ⚠️ 不落任何临时文件：记 2026-11-09 那次 `mktemp` + `trap rm` 被沙箱删除钩子
#    拦下、发布成功却非零退出。APK 通过管道直接进 python 内存（3.65MB，够小）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-https://home.xiaokubao.space/schedule}"
SITE="${BASE_URL%/}"
# publish-apk.sh 会把 BASE_URL 改写成「站点根 + /dl」后 export 出来（它自己要拼
# 上传路径）。守护脚本独立跑时拿到的是站点根。两种都认，别拼出 /dl/dl；
# API_BASE 的默认值也要跟着规范化后的站点根走，不能继承那个带 /dl 的值。
case "$SITE" in
  */dl) SITE="${SITE%/dl}" ;;
esac
API_BASE="${API_BASE:-$SITE}"
DL="$SITE/dl"

ok()   { printf '  \033[0;32mok\033[0m  %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
die()  { printf '\n\033[1;31m!! 自更新守护未通过：%s\033[0m\n' "$*" >&2; exit 1; }

printf '\n\033[1;36m== 自更新链路守护（%s）\033[0m\n' "$DL"

MANIFEST="$(curl -sS --noproxy '*' -H 'Cache-Control: no-cache' "$DL/version.json")" \
  || die "拉不到 $DL/version.json"
[ -n "$MANIFEST" ] || die "version.json 是空的"

URL="$(printf '%s' "$MANIFEST" | python -c '
import json, sys
try:
    print(json.load(sys.stdin).get("url", ""))
except Exception:
    print("")
')"
[ -n "$URL" ] || die "version.json 里没有 url"
case "$URL" in
  */*|*..*|*\ *) die "version.json 的 url 不合法（含路径/空格）：$URL" ;;
esac
ok "清单可取，url=$URL"

export GUARD_MANIFEST="$MANIFEST"
export GUARD_API_BASE="${API_BASE%/}"
export GUARD_GRADLE="$ROOT/app/android/app/build.gradle"

PY="$(cat <<'PYEOF'
import hashlib, io, json, os, re, sys, zipfile

errs = []
def bad(s):
    errs.append(s)
    print('  !!  ' + s)

def good(s):
    print('  ok  ' + s)

try:
    m = json.loads(os.environ['GUARD_MANIFEST'])
except Exception as e:
    print('  !!  version.json 不是合法 JSON: %s' % e)
    sys.exit(1)

vc = m.get('versionCode')
vn = m.get('versionName')
sha = str(m.get('sha256', '')).lower()
url = str(m.get('url', ''))
if not isinstance(vc, int) or vc <= 0:
    bad('versionCode 不是正整数: %r' % vc)
if not vn:
    bad('versionName 为空')
if not re.fullmatch(r'[0-9a-f]{64}', sha):
    bad('sha256 不是 64 位十六进制: %r' % sha)
if str(vc) not in url:
    bad('url(%s) 里找不到 versionCode(%s) —— 清单可能指向旧包' % (url, vc))
if not errs:
    good('清单字段齐全：versionCode=%s versionName=%s' % (vc, vn))

raw = sys.stdin.buffer.read()
if not raw:
    bad('线上 APK 是 0 字节')
    print('')
    for e in errs:
        print('  !!  ' + e)
    sys.exit(1)

actual = hashlib.sha256(raw).hexdigest()
if actual == sha:
    good('线上包 sha256 与清单一致（%s…%s，%d 字节）' % (actual[:8], actual[-4:], len(raw)))
else:
    bad('线上包 sha256=%s… 清单写的是 %s…（上传被截断或清单串包）' % (actual[:12], sha[:12]))

try:
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()
except Exception as e:
    bad('线上 APK 打不开（不是完整 zip）: %s' % e)
    z = None
    names = []

if z is not None:
    if 'assets/public/index.html' not in names:
        bad('包里没有 assets/public/index.html（Capacitor 资源没打进去）')
    else:
        good('包里有 assets/public/index.html')

    js = [n for n in names if n.startswith('assets/public/assets/') and n.endswith('.js')]
    if not js:
        bad('包里没有前端 JS（assets/public/assets/*.js）')
    else:
        blob = b''.join(z.read(n) for n in js)
        base = os.environ['GUARD_API_BASE'].encode('utf-8')
        if base in blob:
            good('内置 JS 已注入接口基址 %s（%d 个 js）' % (base.decode(), len(js)))
        else:
            bad('内置 JS 缺接口基址 %s —— 装上会连不上后端（同源版回归）' % base.decode())

    # 只提示：开发中本地 versionCode 可能已经领先线上，这不是线上坏了
    try:
        txt = open(os.environ['GUARD_GRADLE'], encoding='utf-8', errors='ignore').read()
        local = int(re.search(r'versionCode\s+(\d+)', txt).group(1))
        if vc < local:
            print('  --  线上 versionCode=%s 落后于本地 build.gradle=%s（还没发？）' % (vc, local))
        else:
            good('线上 versionCode >= 本地 build.gradle（%s）' % local)
    except Exception:
        pass

print('')
if errs:
    for e in errs:
        print('  !!  ' + e)
    sys.exit(1)
print('  \033[0;32m自更新守护通过\033[0m：客户端现在拉到的包是完整且可用的。')
PYEOF
)"

set +e
curl -sS --noproxy '*' -f "$DL/$URL" | python -c "$PY"
RC=$?
set -e
[ "$RC" -eq 0 ] || die "线上包体检失败（python 退出码 $RC）"
