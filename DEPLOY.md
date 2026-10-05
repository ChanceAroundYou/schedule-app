# 日程清单 —— 部署与运维

nginx 怎么操作、conf 怎么写、改完代码怎么上线、出问题怎么退。
命令都是在这台机器（Ubuntu，`192.168.1.6`）上实测过的，路径照抄即可。

面向人：部署、排查线上问题、迁移到新机器。
面向 AI：改路由、改缓存策略前先读「五、与现行结构的适配」——那几条每条都是踩坑换来的。

> **2026-10-06 起本项目前后端分离了。** 前端 React 构建产物 + 一个自写的
> Node 后端（SQLite），数据在服务器上。**旧版那份「纯静态、数据只在浏览器里」
> 的说明已经作废**，但旧版整个留档在 `legacy/`，随时可以退回去。

---

## 一、拓扑，一张图

```text
公网
  │
  ▼
Cloudflare 隧道（home-xiaokubao，在路由器上）→ CF ingress 分流
  │
  ▼  home.xiaokubao.space 直达本机
┌──────────────────────────────────────────────────────────────┐
│ nginx 容器  fholzer/nginx-brotli:v1.29   network_mode:host     │
│   /etc/nginx/conf.d/servers/*.conf   ← 只有这些被自动 include   │
│   /etc/nginx/conf.d/home/*.conf      ← 由 server 块显式 include│
│                                                              │
│   /schedule/      → /data/schedule/dist/   静态，alias 直读    │
│   /schedule/api/  → 127.0.0.1:25692        反代到后端          │
└──────────────────────────────────────────────────────────────┘
        ▲                                     ▲
        │ /data/schedule（docker 挂载项目根）   │ 127.0.0.1:25692
        │                                     │
 /home/xiaokubao/family/星星包/coding/日程管理   schedule-backend.service
 （= /mnt/fnos/family/…，SMB 挂在飞牛 NAS 上）  （systemctl --user）
                                               │
                                               ▼
                        /home/xiaokubao/.local/share/schedule/schedule.db
                        ⚠️ 本机磁盘，不在 NAS 上（原因见 1.2）
```

### 1.1 两个进程，各自独立

| | 前端 | 后端 |
|---|---|---|
| 是什么 | Vite 构建产物 | Node 22 + node:sqlite，零 npm 依赖 |
| 谁在伺服 | nginx（容器） | systemd user 服务 |
| 端口 | 无（nginx 直读文件） | 127.0.0.1:25692 |
| 改完怎么生效 | `npm run build`，刷新即生效 | `systemctl --user restart schedule-backend` |
| 挂了会怎样 | 白屏 | 页面能开，接口全 404，登录不上 |

**后端只监听 127.0.0.1**，不直接对外，所以不用自己做 TLS；
外网访问一律经 nginx 的 `/schedule/api/` 反代进来。

### 1.2 数据为什么放本机磁盘，不放工程目录

工程目录挂在 **CIFS/SMB** 上（`//fn.xiaokubao.space/团队文件-family`）。
**SQLite 的文件锁在 CIFS 上不可靠**，写了坏页是不可恢复的。所以：

```bash
SCHEDULE_DATA_DIR=/home/xiaokubao/.local/share/schedule
```

这个目录里就三样：`schedule.db`（+ `-wal` / `-shm`）、`secret.key`（令牌签名密钥，0600）。

**备份 = 拷这一个目录**：

```bash
systemctl --user stop schedule-backend     # 先停，WAL 才会干净落盘
cp -a ~/.local/share/schedule ~/schedule-backup-$(date +%Y%m%d)
systemctl --user start schedule-backend
```

> `secret.key` 丢了 = 所有人被登出（令牌验不过），数据不影响。
> `schedule.db` 丢了 = 数据没了（用户还能从侧栏「导出备份」的 JSON 里救回来）。

| 路径（宿主机） | 内容 |
|---|---|
| `/mnt/fnos/family/星星包/coding/日程管理` | 全部源码 + `dist/`（本项目仓库） |
| `/home/xiaokubao/.local/share/schedule` | **运行时数据：SQLite 库 + 密钥** |
| `/home/xiaokubao/docker/nginx` | nginx 的 compose + `conf.d/` + `certs/` |

> `/home/xiaokubao/family` 是指向 `/mnt/fnos/family` 的软链，同一份文件，
> 两个路径都能开。compose 与 systemd 单元里用的都是软链那条。

---

## 二、改完代码怎么上线

### 2.1 只改前端

```bash
cd /mnt/fnos/family/星星包/coding/日程管理/app
npm run build          # 产物直接写进 ../dist/
```

就这一步。`dist/` 是 NAS 共享目录，nginx 直接读它，**不需要重启任何服务**。
刷新页面即生效（`index.html` 是 `no-cache`，`assets/` 带内容哈希可以长缓存）。

### 2.2 改了后端

```bash
cd /mnt/fnos/family/星星包/coding/日程管理
node server/tests/api.test.js          # 先跑测试
systemctl --user restart schedule-backend
journalctl --user -u schedule-backend -f   # 看有没有起来
```

> **非交互式 shell 里 `systemctl --user` 会报「Failed to connect to user scope bus」。**
> 因为它找不到会话总线。加上这两行就行：
> ```bash
> export XDG_RUNTIME_DIR=/run/user/$(id -u)
> export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
> ```
> 在正常终端里不用管 —— 只有脚本 / CI / AI 跑的命令会撞上。

### 2.3 改了 nginx 配置

```bash
# 1. 改 deploy/schedule.conf（本地副本，保持两边一致）
cp -p ~/docker/nginx/conf.d/home/schedule.conf \
      ~/docker/nginx/conf.d/home/schedule.conf.bak-$(date +%Y%m%d-%H%M%S)
# 2. 这台机器就是服务器，直接 cp（别 ssh 自己）
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
# 3. 校验 + 重载
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

### 2.4 后端服务的安装 / 换机器

```bash
cp deploy/schedule-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now schedule-backend
```

这台机器已经开了 linger（`loginctl show-user xiaokubao` → `Linger=yes`），
用户级服务注销后照样活着。**换机器要先确认这一条**，否则一关 SSH 服务就没了。

> 单元里 `ExecStart` 钉死了 `/home/xiaokubao/.nvm/versions/node/v22.22.3/bin/node`。
> **别改成 `/usr/local/bin/node`** —— 那是个指向 nvm `v22.16.0` 的软链，
> 而 `node:sqlite` 在 22.16 上还要 `--experimental-sqlite`。升级 node 时改这一行。

---

## 三、nginx 怎么操作

### 3.1 校验与重载

```bash
docker exec nginx nginx -t          # 必须先 -t，reload 不会自己检查
docker exec nginx nginx -s reload
```

> **用 `docker exec`，不要 `docker run ... nginx -t`。** 该镜像的 entrypoint
> 已经是 nginx，`docker run` 传 `nginx -t` 会报 `nginx: invalid option: "nginx"`。

`-t` 不通过就别 reload —— 容器里的配置是直接挂进去的，改坏了 reload 会把
线上所有站点一起带下去。

### 3.2 配置目录怎么分工

容器里的 `nginx.conf` 只自动 include 两处：

```nginx
include /etc/nginx/conf.d/global/*.conf;
include /etc/nginx/conf.d/servers/*.conf;
```

其余目录**由 `servers/` 里的 server 块用绝对路径显式 include**。
所以往 `home/` 里加文件不会有任何效果 —— 必须同时在 `servers/home.conf`
加一行 `include`。**这是最容易踩的一步。**

```text
conf.d/
├── global/     自动 include —— brotli、map、proxy-cache、resolver
├── servers/    自动 include —— 每个域名一个 server 块
│   └── home.conf          ← home.xiaokubao.space，本项目在这里挂载
├── common/     被 include —— ssl.conf、proxy.conf
└── home/       被 servers/home.conf include —— 各子路径的 location
    ├── balancebook.conf   ← 个人账本
    ├── balanceapi.conf    ← 账本的 API 反代（**后端反代单独一个文件是那边的习惯**）
    └── schedule.conf      ← 本项目，静态 + API 都在这一份里，本地副本在 deploy/
```

> 本项目**没有**按账本那样拆成两个文件 —— 就一块 `/schedule/`，放一起更好读。
> 想拆也行，但那要在 `servers/home.conf` 再加一行 include，多一个会忘的地方。

### 3.3 停用一个站点

**把 `.conf` 改名成 `.conf.disabled`。** include 只匹配 `*.conf`，
改了名就不生效，不用动别的文件。

### 3.4 HTTPS

```nginx
# conf.d/common/ssl.conf
ssl_certificate     /etc/letsencrypt/live/xiaokubao.space/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/xiaokubao.space/privkey.pem;
error_page 497 https://$host:$server_port$request_uri;   # 明文请求直接跳 HTTPS
```

宿主机的 `certs/live/xiaokubao.space/`（`docker-compose.yml` 里挂成只读）就是这一份。

> **续期没有自动化。** 宿主机上没有 certbot 容器，`crontab` 与 systemd timer 里
> 也没有相关条目，证书文件停在 2026-09-21 那次签发。
> 当前证书 **2026-11-03 到期**，且覆盖 `*.xiaokubao.space` 通配。
> 换证书：把四个 pem 覆盖到 `certs/live/xiaokubao.space/`，然后 `nginx -t && reload`。
> 过期前一周记得看一眼：`openssl x509 -in ... -noout -enddate`。
>
> **这条是全站共用的**（账本等其他站点同样在 `*.xiaokubao.space` 下），
> 换证书对所有子路径一起生效。

---

## 四、conf 怎么写

本项目只有一个文件，七十来行。**照着改，别新造轮子。**
完整内容见 `deploy/schedule.conf`（本地副本），服务器上生效的那份在
`~/docker/nginx/conf.d/home/schedule.conf`。

骨架：

```nginx
location = /schedule { return 301 /schedule/; }          # 补斜杠

location ^~ /schedule/api/ {                              # 后端反代
    proxy_pass http://127.0.0.1:25692/api/;
    ...
    add_header Cache-Control "no-store" always;
}

location ^~ /schedule/app/          { return 404 "not found"; }   # 源码
location ^~ /schedule/server/       { return 404 "not found"; }   # 后端源码 + 库
location ^~ /schedule/legacy/       { return 404 "not found"; }
location ^~ /schedule/.             { return 404 "not found"; }   # 点开头的内务

location ^~ /schedule/assets/ {                           # 带哈希，可以长缓存
    alias /data/schedule/dist/assets/;
    expires 1y;
    add_header Cache-Control "public, immutable";
}

location ^~ /schedule/ {                                  # 应用本体
    alias /data/schedule/dist/;
    index index.html;
    add_header Cache-Control "no-cache";
}
```

### 六条要记住的

1. **`^~` 不能省。** 少了它，`location ~` 的正则会抢在前面匹配，
   `dist/` 里的文件名会被别的正则 location 截走。

2. **`/schedule/api/` 必须比 `/schedule/` 长，两块都得是 `^~`。**
   nginx 在多个 `^~` 前缀块里**选最长的那个**，所以文件里的先后顺序无所谓 ——
   但两块都带 `^~` 才成立，否则 API 请求会落进静态块里 404。

3. **`location /schedule/.` 也要写成前缀块，不能写成 `location ~ ^/schedule/\.`。**
   上面那些 `^~` 一旦命中就直接停止正则匹配，**正则块永远不会被求值** ——
   那是死代码，而且看起来还挺像在防护。前缀匹配是字面量，`/schedule/.`
   能覆盖 `.git/` `.omc/` `.claude/` `.workbuddy/` `.mindfs/` 全部。

4. **用 `alias` 不用 `root`。** 项目根是**整个**挂到 `/data/schedule` 的，
   `root` 会把 `/schedule/` 拼成 `/data/schedule/schedule/`。

5. **只对外提供 `dist/`。** 顺带一提：`alias …/dist/` 本身就已经隔离了源码
   （`/schedule/app/x` 会去找 `dist/app/x`，不存在就是 404）。那一串 404 是
   第二道锁 —— 万一以后有人把它改成 root 指向项目根，源码不会跟着裸奔。
   `server/` 尤其要紧：那里有 SQLite 库和 `secret.key`。

6. **`proxy_pass` 结尾的 `/api/` 不能丢。** 带了 URI 部分，nginx 才会把
   匹配到的前缀替换掉（`/schedule/api/tasks` → `/api/tasks`）；
   少了它，后端会收到带 `/schedule` 前缀的路径，全是 404。

### 4.1 缓存策略：三档，别混

| 路径 | 策略 | 原因 |
|---|---|---|
| `/schedule/assets/*` | **`expires 1y` + `immutable`** | Vite 产物带内容哈希（`index-B9em1qd9.js`），内容一变文件名就变 |
| `/schedule/index.html` | **`no-cache`** | 文件名固定，必须每次回源校验，否则用户被钉在旧版本上 |
| `/schedule/api/*` | **`no-store`** | 带 `Authorization` 的响应被中间层存下来就是事故 |

> 旧版（纯静态那一代）**整套**都得 `no-cache`，因为那时候 `app.js` /
> `styles.css` 的文件名固定、没有哈希。现在只有 `index.html` 需要了 ——
> 别再照抄旧结论。

> `no-cache` 不是「不缓存」。它仍然缓存，只是每次用前必须回源校验。
> `no-store` 才是完全不存。

### 4.2 `/schedule` 无尾斜杠必须显式 301

少了尾斜杠时，页面里的相对路径（`./api/…`、`./assets/…`）会解析到
`/api/…`、`/assets/…` 而不是 `/schedule/…` → **接口全 404 + 白屏**。
nginx 不会自动补斜杠，必须显式 `return 301`。

前端发请求用的是 `fetch('./api/' + path)`（`app/src/data/api.ts`），
就是靠这个相对路径做到「前后端同源、后端一行 CORS 都不用写」的。
**改前端请求路径前先想清楚这条。**

### 4.3 Service Worker：新旧两代要分清楚

**新版自己注册一个**（`app/public/sw.js` → `dist/sw.js`），作用只有一个：
**断网时还能把应用打开**。数据层本来就是离线的（localStorage + outbox），
缺的一直是「页面本身加载不出来」。

**旧版那个必须拆掉**，它是「怎么刷新都是旧界面」的根因：旧版注册的 sw.js
（缓存名 `schedule-v12`）缓存里有**旧版 index.html**，网络抖动时它回那份 HTML，
那份 HTML 又去加载 app.js / views.js。

拆解在 `app/src/main.tsx` 的 `migrateAwayFromLegacySW()`，**用 localStorage
标记锁成一次性**（`schedule-sw-migrated`）—— 否则它每次启动都会把新版刚注册的
那个也一起注销掉。删缓存时只认 `/^schedule-v\d+$/`，新版那个 `sched-shell-*`
不删。重载仍带 `sessionStorage` 标记，防空转。

`/schedule/sw.js` 现在**返回 200**（旧版时期它也在，所以别看到它不是 404 就慌）。
nginx 那条 `^~ /schedule/` 给它的 `no-cache` 是对的：浏览器每次导航都会重新
校验 SW 脚本，改了策略立刻生效。

> 改了 `sw.js` 的**缓存策略**要顺手改 `CACHE` 名（`sched-shell-v1`），
> 否则 `activate` 里删旧缓存那一步不会触发。
> 只改 `sw.js` 的**代码**不用动版本号。

**预缓存清单是装的时候现场抠的，不写死在源码里** —— 构建产物的文件名带哈希
（`index-DMHSyzQa.js`），写死会在下一次 `npm run build` 后立刻过期。
`precacheShell()` 的做法是：拿 `index.html`，正则抠出里面引用的 `/assets/…`，
连同 `manifest.json` / `icon.svg` 一起存进缓存。

> 这段是补上来的，之前没有：**不预缓存的话，第一次访问是存不下东西的** ——
> 那一趟的资源早在 SW `activate` 之前就直连网络拿完了，于是「断网能用」
> 要等到第二次打开才有。线上实测过一次（`caches` 是空的）才发现的。
> 现在的验收标准是：**打开一趟，`caches.keys()` 里就该有那 5 条**
> （index.html / manifest.json / icon.svg / assets 的 js 与 css）。

所以**离线能力的前提仍然是「这台设备联网打开过一次」** —— 第一次访问就是
那次联网访问，装完即有；从没访问过的设备断网打开只会看到兜底页
（`COLD_OFFLINE`，一句「先联网打开一次」）。

> 顺手记一笔：CSS 在 `index.html` 里是 `<link href>`、JS 是 `<script src>`，
> 正则两种都收。以后构建形态变了最坏结果是少预缓存一个文件，
> 那个文件仍会在第一次真正用到时被 `cacheFirst` 存下来。


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

### 5.3 「刷新即生效」的前提

nginx 直挂 `dist/`，**没有上传步骤**。但前端现在**有构建**了：

- **只对 `dist/` 生效。** 改完源码必须 `npm run build`，否则页面纹丝不动。
- **Service Worker 可能挡着**（旧版那一个），见 4.3。
- **SMB 有写入延迟。** `npm run build` 会先清空 `dist/` 再写，
  一般不会碰到；真碰到了等几秒重跑。

---

## 六、发布流程

```text
1. 改代码（前端在 app/，后端在 server/）
2. cd app && npm test && npm run typecheck        # 有改后端就加 node server/tests/api.test.js
                                                  # 改了共享/权限再加 node server/tests/smoke-share.mjs
3. cd app && npm run build                        # 前端产物 → ../dist/
4. 改了后端才需要：systemctl --user restart schedule-backend
5. 刷新页面
```

**没有部署脚本。** 账本那个七步的 `deploy.sh` 是给「有镜像、有健康检查」的项目用的，
本项目没有镜像、没有容器（后端是宿主机上的 systemd 服务），不需要那一套。

> 改了共享相关的东西（`lib/calendars.js`、`lib/invites.js`、`lib/sync.js` 的权限判断），
> **必须跑 `smoke-share.mjs`** —— 单元测试只测各段逻辑，这条测的是它们串起来通不通。

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

比上面那一堆 curl 有用得多 —— 它真的开浏览器注册、建任务、勾选、刷新、确认同步。

**优先跑这两个，它们在临时目录里起自己的后端，不碰线上库：**

```bash
cd /mnt/fnos/family/星星包/coding/日程管理
node server/tests/smoke-share.mjs            # 两个用户共享一个日程集的完整流程
cd app && npm run build && node tests/browser-smoke.mjs   # 真实 Chrome 走一遍界面
```

旧的 `app/tests/smoke.mjs` 打的是**已部署的那份**：

```bash
BASE=https://home.xiaokubao.space/schedule/ node app/tests/smoke.mjs
```

⚠️ **它会在那个服务器上注册一个新账户。** 注册现在是开放的，所以多出来的
账户不会挡住谁 —— 但线上真有你在用的账户时，**别再拿它打线上**：
起个本机后端（`SCHEDULE_DATA_DIR=/tmp/x node server/server.js`）+ 前端 preview
跑，一样能验。

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

## 七、回滚

新版整个走的是 `/schedule/`，**没有第二套路径并存**，所以回滚是「换掉 dist/ 的内容」。

| 故障 | 回滚动作 |
|---|---|
| 新版前端有问题 | `rm -rf dist/* && cp -a legacy/dist/. dist/` —— 立刻退回旧版纯静态应用，刷新即生效 |
| 新版后端有问题 | `systemctl --user stop schedule-backend`。页面还开得了，但登录不上、同步停摆（离线副本仍可看） |
| 想临时下线整站 | `conf.d/home/schedule.conf` 改名 `.conf.disabled` → `nginx -t && reload` |
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

## 八、环境踩坑

**8.1 非交互式 shell 里 `systemctl --user` 连不上总线**

```
Failed to connect to user scope bus via local transport:
$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined
```

脚本、CI、AI 执行命令时都会撞上（它们没有登录会话）。补上：

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
```

**8.2 工程目录在 SMB 上，偶发丢文件**

工程目录挂在 CIFS 上（`actimeo=1` `nobrl` `mapposix`，`/mnt/fnos` 还是个
`timeout=3` 的 autofs）。**2026-10-06 实测丢过一次 `app/src/App.tsx`**：
编辑工具写完当场还在，几十秒后整个文件没了，没有 recycle 目录、没进 git。

- 传大文件先写到本机磁盘再 `cp` 过去，然后 `md5sum` 两端核对
- 写完 / 移动完**立刻 `ls -l` 确认还在**
- `app/` 曾经没进版本库 —— **改完记得提交**，这是唯一可靠的后悔药
- 源码没必要放在共享盘上；真要图方便，至少保证 git 是最新的

**8.3 `pkill -f "…"` 会打到自己**

`pkill -f "node server/server.js"` 连同一条命令里的 shell 一起杀掉（exit 144），
因为 zsh 的命令行本身就含这个字符串。要么拆成两条命令，
要么把模式写成 `node [s]erver/server.js` 并且**别在同一条命令里出现字面量**。

**8.4 `scp` 传中文路径报 `pipe: Unknown error`**

从 Windows 连过来时 `scp` 传含中文的路径会失败。改用：

```bash
cat 本地文件 | ssh ubuntu "cat > 目标路径"
# 然后 md5sum 校验两端一致
```

**8.5 这台机器上没有 `nas` 这个 SSH 别名**

`~/.ssh/config` 里本机叫 **`ubuntu`**（`HostName home.xiaokubao.space`），
也有 `fn` 指同一台。`nas` 是 Windows 侧用的名字。
**在本机上执行 `ssh nas` 会报 `Could not resolve hostname nas`。**

而且 —— **这台机器（`192.168.1.6`，`ubuntu`）就是 nginx 与后端所在的那台**，
`ssh` 到自己没必要，改配置直接 cp（见 2.3）。

**8.6 `docker run ... nginx -t` 报 invalid option**

该镜像 entrypoint 已是 nginx，改用 `docker exec nginx nginx -t`。

**8.7 无头 Chrome 有最小窗口宽度约 526px**

`--window-size=390` 实测 `innerWidth` 是 526，量不到真手机宽度。

> **别用 iframe 绕。** 旧版试过用固定宽度的 iframe 包住应用，
> 结果是 headless 下 `iframe.onload` 时序不可靠、经常不触发，
> 拿不到数据等于没测 —— 那段已经放弃了（`legacy/tests/drop-scan.mjs` 头部有结论）。
> `Emulation.setDeviceMetricsOverride` 也不行，它会触发完整重排、
> 之后合成事件不再进处理器。

**新版没有窄屏 / 触屏的自动化覆盖** —— `app/tests/smoke.mjs` 只跑一个
1440×900 的桌面视口，≤900px 的标签栏、长按操作层只能手工在真机上看。
其余测试坑见 [CLAUDE.md](CLAUDE.md) 「四、33」。

---

## 九、故障排查

| 现象 | 查什么 |
|---|---|
| 改了代码但页面没变 | 前端要 `npm run build`（nginx 只挂 `dist/`）；再清 Service Worker，见 4.3 |
| 页面能开，但登录不上 / 操作没反应 | `systemctl --user status schedule-backend`；`journalctl --user -u schedule-backend -n 50` |
| 接口全 404 | nginx 里 `/schedule/api/` 那块丢了或没带 `^~`；后端没起 |
| 页面 404 | `servers/home.conf` 里忘了 `include` `schedule.conf` |
| 页面能开但资源全 404 | `base: './'`（`app/vite.config.ts`）被改成 `/` 了；或访问的是 `/schedule`（无尾斜杠） |
| 白屏 + 资源 404 | 访问的是 `/schedule` 而不是 `/schedule/`，相对路径解析到了站点根 |
| 还是一年前的旧界面 | 旧版 Service Worker 没清掉。强刷，或 DevTools → Application → Service Workers 里 Unregister |
| 两台设备数据不一致 | 顶栏右侧的同步图标还在转？转 → 还在推；不转 → 看后端日志。逐字段 LWW，同一字段才是「后改的赢」 |
| 数据不对 / 像丢了几条 | **先看服务器库**（浏览器那份只是副本）。`sqlite3 ~/.local/share/schedule/schedule.db '.tables'` |
| 所有人都掉登录了 | `secret.key` 被换掉 / 删了。数据不受影响，重新登录即可 |
| 后端起不来，日志里 EADDRINUSE | 有个手动起的 `node server.js` 还占着 25692。`ss -lptn 'sport = :25692'` |
| `sync-dist.mjs` | **这个脚本已经没有了**（旧版纯静态时代的东西）。前端现在是 `npm run build` |
| 证书快过期 | 三·3.4，**没有自动续期**，全站共用 |
| 手机装成 App 后霸占整站 | PWA `scope`（`app/public/manifest.json` 里是 `./`，已锁在 `/schedule/`） |

---

## 十、相关文档

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 数据模型、代码约定、踩坑记录（**改代码前先读**） |
| [README.md](README.md) | 怎么用、数据在哪、日常命令 |
| [docs/接口.md](docs/接口.md) | HTTP 接口一览 |
| [docs/重构路线.md](docs/重构路线.md) | 这次前后端分离重写的决策记录 |
| `deploy/schedule.conf` | nginx 配置的本地副本（服务器上还有一份） |
| `deploy/schedule-backend.service` | 后端 systemd user 单元的本地副本 |
| `/home/xiaokubao/docker/nginx/conf.d/README-hosts.md` | 全站域名 ↔ 设备 ↔ 路径的映射表 |
| `/home/xiaokubao/docker/nginx/conf.d/home/balanceapi.conf` | 账本的 conf，写 location 时可对照 |
