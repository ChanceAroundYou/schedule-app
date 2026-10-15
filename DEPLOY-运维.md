# 部署 · 发布 / 回滚 / 结构适配

> **五份运维文档**：拓扑与上线 → [DEPLOY.md](DEPLOY.md)；nginx 怎么操作 →
> [DEPLOY-nginx.md](DEPLOY-nginx.md)；conf 怎么写 → [DEPLOY-conf.md](DEPLOY-conf.md)；
> 发布 / 回滚 / 结构适配 → [DEPLOY-运维.md](DEPLOY-运维.md)；环境踩坑与故障排查 →
> [DEPLOY-排障.md](DEPLOY-排障.md)。**章节号沿用原来的，交叉引用不用改。**


---

## 五、与现行结构的适配（最容易照抄错的地方）

### 5.1 接口没有版本号

**`/api/*`，不带 `v1` / `v2` / `v3`。** 只有一套接口，也就没有「旧路径 301 跳回
当前版」这回事。账本那套版本号规则**一条都不适用**。

```text
GET  /api/health          存活探针，不需要登录
POST /api/auth/register   注册。**开放**，只要没到 MAX_USERS（默认 200）
POST /api/auth/login
POST /api/auth/logout     把当前令牌加进吊销表
GET  /api/me              我是谁 + 我有哪些日程集 + 谁邀请了我（启动只发这一个）
POST /api/sync            推 + 拉，一次往返（body 里有 ops 和 cursor）

日程集 / 成员 / 邀请
GET    /api/cals
POST   /api/cals
PATCH  /api/cals/:calId                     改名（owner）
DELETE /api/cals/:calId                     删集（owner）
POST   /api/cals/:calId/leave               自己退出
GET    /api/cals/:calId/members             成员 + 我发出去待处理的邀请
PATCH  /api/cals/:calId/members/:userId     改角色（owner）
DELETE /api/cals/:calId/members/:userId     移出（owner）
POST   /api/cals/:calId/invites             发邀请（owner）
GET    /api/cals/:calId/invites
GET    /api/invites                         发给我的（收件箱）
POST   /api/invites/:inviteId/accept|decline
DELETE /api/invites/:inviteId               撤回
```

接口细节（请求 / 响应 / 错误码）见 [docs/接口.md](docs/接口.md)。

> **没有管理员，注册是开放着的。** 所有人权限相同，靠**日程集**共享内容
> （类似相册：你可以有多个集，每个集里的人各不同）。共享的单位是集，不是单条任务。
>
> 两条底线由 `server/lib/calendars.js` 保证：**每个人始终至少属于一个日程集**
> （退出 / 被踢 / 集被删之后自动补一个「我的日程」），**每个集始终至少有一个
> owner**（最后一个人不能降级、不能退出）。改这块之前先读那个文件头的注释。

> **`/api/me` 是「我是谁」，登录后第一件事就调它。** 旧的 `GET /api/auth/state`
> 与 `GET|POST /api/users`（那套「空库注册成管理员、之后关掉注册」）**已经删掉**，
> 别再照抄。

### 5.2 数据存在哪儿，决定了备份怎么做

| | 旧版 | 现在 |
|---|---|---|
| 真相在哪 | 浏览器 localStorage | 服务器 SQLite |
| 换设备 | 导出 / 导入 JSON | 登录同一个账户 |
| 备份 | 手动导 JSON | 拷 `/home/xiaokubao/.local/share/schedule` |
| 服务器上有没有用户数据 | **没有** | **有**（这是最大的变化） |

浏览器那份（`schedule-app-v4`）是**离线副本**，不是真相 —— 排查「数据不对」时
先看服务器，别只看浏览器。

旧版的 `schedule-app-v1` **不删**（第一次登录时读一次导入，之后不再碰），
留作回滚时还能找回旧数据。

### 5.3 「刷新即生效」的前提（2026-10-15 改写）

线上读的是 `~/.local/share/schedule-web/`（本机磁盘），**不是工程里的 `dist/`**：

- **改完源码要发布**，`npm run build` 只产出本地 `dist/`。发布走
  `./deploy/publish-web.sh`（构建 → 上传 → 备份 → 切换 → 回读校验）。
- **Service Worker 可能挡着**（旧版那一个），见 4.3。
- ⚠️ **发布脚本只换目录内容，不换目录本身** —— Docker bind mount 认 inode，
  `mv` 掉目录会让 nginx 直接 403 且不自愈。见 `DEPLOY.md` 1.4。

---

---

## 六、发布流程

```text
1. 改代码（前端在 app/，后端在 server/）
2. cd app && npm test && npm run typecheck        # 有改后端就加 node server/tests/api.test.js
                                                  # 改了共享/权限再加 node server/tests/smoke-share.mjs
3. ./deploy/publish-web.sh                        # 前端：构建 + 发布（含备份与回读校验）
4. ./deploy/publish-server.sh                     # 改了后端才需要（含 restart 与探活）
5. 刷新页面
```

两个脚本都支持 `--rollback`，从同层的 `.bak-*` 拷回去（本机磁盘，秒级）。

> 以前「没有部署脚本」是真的 —— nginx 直挂 SMB 工程目录的 `dist/`，build 即上线。
> 2026-10-15 改掉了：线上产物搬到 `~/.local/share/`，发布变成显式动作，
> 有备份、有校验、有回滚。理由见 `DEPLOY.md` 1.4。

> 改了共享相关的东西（`lib/calendars.js`、`lib/invites.js`、`lib/sync.js` 的权限判断），
> **必须跑 `smoke-share.mjs`** —— 单元测试只测各段逻辑，这条测的是它们串起来通不通。

### 6.0 改了原生小组件 → 发 APK（自更新）

网页改完刷新就生效，但**小组件、权限、图标在原生层，必须换 APK**。走自更新：

```bash
./deploy/publish-apk.sh "这次改了什么"      # 编译 → 签名 → 上传 → 写 version.json → 回读校验
```

脚本做四件事，见 `deploy/publish-apk.sh` 头部注释。要点：

| | |
|---|---|
| **versionCode 必须手加** | 在 `app/android/app/build.gradle`。客户端只认「服务端大于自己才提示」，忘了加就永远收不到更新 |
| **签名不可换** | keystore 在 `C:/Users/小哭包/.android/schedule-release.jks`，密码在 `app/android/keystore.properties`（**gitignore**）。换 keystore = 覆盖安装失败 = 用户卸载重装、数据重拉 |
| **服务端目录** | `~/.local/share/schedule-apk/`（**本机磁盘**，不在 NAS 的工程目录里）。nginx 挂在 `/schedule/dl/`，`no-store` |
| **上传用 ssh 管道** | 这台 Windows 上 `scp` 报 `pipe: Unknown error`，脚本里是 `ssh host "cat > 文件" < 本地文件` |

> **首次从 debug 包切到 release 包要卸载一次。** 两者的签名不同，
> `adb install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。数据在服务器上，
> 卸了重装、重新登录就回来了（小组件的票据要重新推一次）。

### 6.1 发布后验证

```bash
B=https://home.xiaokubao.space/schedule

# 1. 路由与隔离
for p in "/" "/manifest.json" "/icon.svg" "/api/health" "/api/me" \
         "/app/src/main.tsx" "/server/server.js" "/legacy/dist/app.js" \
         "/deploy/schedule.conf" "/.git/config" "/docs/" "/api/auth/state" "/api/users"; do
  printf '%-26s %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' $B$p)"
done
```

期望（2026-10-06 实测）：

```text
/                          200
/manifest.json             200
/icon.svg                  200
/api/health                200    ← 反代通了，不需要登录
/api/me                    401    ← 需要登录；**401 而不是 404** 才说明这条路由在
/app/src/main.tsx          404    ← 源码不对外
/server/server.js          404    ← 后端源码不对外
/legacy/dist/app.js        404    ← 旧版留档不对外
/deploy/schedule.conf      404
/.git/config               404    ← 点开头的内务不对外
/docs/                     404
/api/auth/state            404    ← 已删：这套接口没有「注册开关」了
/api/users                 404    ← 已删：没有管理员接口
```

```bash
# 2. 缓存头三档
curl -skI $B/index.html                       | grep -i cache-control   # no-cache
curl -skI $B/assets/$(ls dist/assets | grep '\.js$') | grep -i cache-control   # public, immutable
curl -skI $B/api/health                       | grep -i cache-control   # no-store

# 3. 补斜杠
curl -sk -o /dev/null -w '%{http_code} -> %{redirect_url}\n' $B
# 301 -> https://home.xiaokubao.space/schedule/
```

### 6.2 端到端冒烟

比上面那一堆 curl 有用得多 —— 它真的开浏览器注册、建任务、勾选、刷新。

**这个还在，它在临时目录里起自己的后端，不碰线上库：**

```bash
cd /mnt/fnos/family/星星包/coding/日程管理
node server/tests/smoke-share.mjs            # 两个用户共享一个日程集的完整流程
```

界面那一侧只剩**静态 / 几何**探针（2026-10-15 删掉了 `browser-smoke.mjs`
与 `browser-dayview.mjs`，它们卡在等 Service Worker 上跑不完）：

```bash
cd app && npm run build && node tests/browser-cards.mjs   # 卡片几何（dist 要同源构建）
cd app && node tests/contrast.mjs && node tests/color-scan.mjs
```

> 交互（注册 → 建任务 → 拖拽 → 同步）**没有自动化覆盖了** —— 发布前在真机或
> 浏览器上手工走一遍。原先那个 `app/tests/smoke.mjs` 打的是已部署的那份，
> 而且会在那个服务器上注册新账户，也已经删掉。

确实要把库清空重来时（**会删掉所有真实用户和他们的日程**）：

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemctl --user stop schedule-backend
rm -rf ~/.local/share/schedule && mkdir -p ~/.local/share/schedule
systemctl --user start schedule-backend
curl -s $B/api/health              # 要看到 {"ok":true,...}
```

> 清库之后**没有「第一个注册的人成为管理员」这回事**了 —— 谁先注册都是
> 平等的普通账户，各自拿到一个「我的日程」。要一起用就发邀请。

### 6.3 抽查既有站点

改了 compose 或 reload 之后，确认没打断别人：

```bash
for p in "/" "/balancebook/" "/docker/" "/mindfs/" "/hermes/"; do
  printf '%-16s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://home.xiaokubao.space$p")"
done
```

---

---

## 七、回滚

新版整个走的是 `/schedule/`，**没有第二套路径并存**，所以回滚是「换掉线上目录的内容」。

| 故障 | 回滚动作 |
|---|---|
| 新版前端有问题 | `./deploy/publish-web.sh --rollback` —— 从 `schedule-web.bak-<版本>-<时间>` 拷回去（保留最近 3 份）。⚠️ 别 `mv` 目录本身，见 `DEPLOY.md` 1.4 |
| 新版后端有问题 | `./deploy/publish-server.sh --rollback`，或者干脆 `systemctl --user stop schedule-backend`（页面还开得了，但登录不上、同步停摆，离线副本仍可看） |
| 想临时下线整站 | `conf.d/home/schedule.conf` 改名 `.conf.disabled` → `nginx -t && reload` |
| App 自更新发了坏包 | 把 `~/.local/share/schedule-apk/version.json` 改回上一个 versionCode（apk 文件留着），或直接删掉 version.json —— 客户端拉不到清单就静默不提示，已经装上的不受影响 |
| nginx 整体起不来 | 恢复备份：`docker-compose.yml.bak-<时间戳>` 与 `conf.d/servers/home.conf.bak-<时间戳>`，再 `docker compose up -d` |

> **退回旧版的注意事项**：旧版读的是 localStorage 的 `schedule-app-v1`，
> 而新版从来不动那个 key（只读一次）。所以退回去之后**旧数据还在**，
> 只是新版期间新加的任务看不到 —— 它们在服务器库和 `schedule-app-v4` 里。
> 新版没有引入 React 之外的数据破坏，随时可以再换回来。

> **备份留在服务器上**：`schedule.conf.bak-20261005-153546`、
> `schedule.conf.bak-20261006-020542`，
> `docker-compose.yml.bak-20261005-140134`、
> `conf.d/servers/home.conf.bak-20261005-140134`。

---
