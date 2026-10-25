# 日程清单 · 部署与运维

一台 Ubuntu（`192.168.1.6`，SSH 别名 `ubuntu`）：nginx 容器伺服前端并反代 `/schedule/api/`，后端是宿主机上的 systemd user 服务（Node 22，只听 127.0.0.1:25692）。

> 本文所有 `~/` 都是服务器 ubuntu 上的家目录，不是 NAS 本机。工程目录只是源码，线上不读它。

## 拓扑

```text
公网 → Cloudflare 隧道 → ubuntu
  → nginx 容器 (host 网络)
    /schedule/    → /data/schedule-web/   静态
    /schedule/dl/ → /data/schedule-apk/   安装包
    /schedule/api/→ 127.0.0.1:25692      后端
  → systemd user: schedule-backend (Node 22)
      ~/.local/schedule/data/schedule.db
```

线上目录 `~/.local/schedule/`：`web/` 前端产物、`app/` 后端代码、`data/` SQLite+secret.key、`deps/` 依赖、`apk/` 更新包。工程目录不挂进容器（`/schedule/server/server.js` 应 404）。

## 发布

发布必须用户授权；脚本默认 dry-run（退出码 1）。

```bash
git add <文件> && git commit && git push
./deploy/publish-web.sh          # dry-run
./deploy/publish-server.sh
./deploy/publish-web.sh --approve
./deploy/publish-server.sh --approve
```

日常用一键闭环：`./deploy/web-loop.sh` / `./deploy/mobile-loop.sh`。

发布前体检：`git status --porcelain` / `git stash list` / `git ls-files -u` / `git log @{u}..` 均须干净。

发布约束（不能破）：
- 只换目录内容，**绝不 `mv` 目录本身**（Docker bind mount 认 inode）。
- 指纹命令里 `sed 's/\*//g' | tr -s ' '` 别删。
- `app/node_modules` 软链只在 `[ ! -e node_modules ]` 时补。
- 打包强制 `--mode='u+rwX,go+rX'`，解包后 chmod 并数文件数。
- 回读校验以服务器磁盘那份 `index.html` 为准。

回滚：`./deploy/publish-web.sh --rollback --approve`（或 server），或停后端服务。

## 验证

```bash
B=https://home.xiaokubao.space/schedule
for p in "/" "/manifest.json" "/icon.svg" "/api/health" "/api/me" \
         "/app/src/main.tsx" "/server/server.js" "/.git/config"; do
  printf '%-24s %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' $B$p)"
done
```

期望：`/` 200 · `/api/health` 200 · `/api/me` 401 · 其余 404。

探针：`node server/tests/smoke-share.mjs` · `node app/tests/browser-smoke.mjs` · `node app/tests/contrast.mjs && node app/tests/color-scan.mjs`。

## 排障

| 现象 | 查什么 |
|---|---|
| 改了代码页面没变 | 是否 publish-web；清 Service Worker |
| 登录不上 / 操作没反应 | `systemctl --user status schedule-backend` |
| 接口全 404 | `/schedule/api/` 那块丢了或没带 `^~`；或后端没起 |
| 页面 404 | `servers/home.conf` 里忘了 include schedule.conf |
| 页面能开但资源全 404 | 访问的是 `/schedule`（无尾斜杠） |
| 两台设备数据不一致 | 顶栏同步图标还在转？逐字段 LWW |
| 数据不对 | **先看服务器库** |
| 所有人都掉登录了 | `secret.key` 被换/删 |
| 后端起不来 EADDRINUSE | `ss -lptn 'sport = :25692'` |

其余环境细节见 [docs/踩坑-环境.md](docs/踩坑-环境.md)。

## 相关文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 结构、不变量、工作约束 |
| [docs/架构决策.md](docs/架构决策.md) | 为什么是现在这样 |
| `deploy/schedule.conf` | nginx 配置本地副本 |
| `deploy/schedule-backend.service` | systemd 单元本地副本 |
