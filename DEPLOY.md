# 日程清单 —— 部署与运维

nginx 怎么操作、conf 怎么写、改完代码怎么上线、已知会踩的坑。
命令都是在这台机器（Ubuntu，`192.168.1.6`）上实测过的，路径照抄即可。

面向人：部署、排查线上问题、迁移到新机器。
面向 AI：改路由、改缓存策略前先读「五、与现行结构的适配」——那几段每条都是踩坑换来的。

> **本项目没有后端、没有数据库、没有登录。**
> 与「个人账本」的部署差异见第五节，那几条是最容易照抄错的地方。

---

## 一、拓扑，一张图

```text
公网
  │
  ▼
Cloudflare 隧道（home-xiaokubao，在路由器上）→ CF ingress 分流
  │
  ▼  home.xiaokubao.space 直达本机
┌──────────────────────────────────────────────────────────┐
│ nginx 容器  fholzer/nginx-brotli:v1.29   network_mode:host │
│   /etc/nginx/conf.d/servers/*.conf   ← 只有这些被自动 include │
│   /etc/nginx/conf.d/home/*.conf      ← 由 server 块显式 include │
│                                                          │
│   /schedule/  →  /data/schedule/dist/   纯静态，无反代       │
└──────────────────────────────────────────────────────────┘
                              ▲
              /data/schedule  ← docker 挂载
                              │
   /home/xiaokubao/family/星星包/coding/日程管理
   （= /mnt/fnos/family/… ，SMB 挂在飞牛 NAS 上）
```

**本项目只有 nginx 一个容器，没有后端容器。** 应用是纯静态的，
数据在浏览器 localStorage 里，服务器上**没有任何用户数据**。

| 路径（宿主机） | 内容 |
|---|---|
| `/mnt/fnos/family/星星包/coding/日程管理` | 全部源码 + `dist/`（本项目仓库） |
| `/home/xiaokubao/docker/nginx` | nginx 的 compose + `conf.d/` + `certs/` |

> `/home/xiaokubao/family` 是指向 `/mnt/fnos/family` 的软链，同一份文件，
> 两个路径都能开。compose 里用的是软链那条。

---

## 二、改完代码怎么上线

```bash
cd /mnt/fnos/family/星星包/coding/日程管理
node tools/sync-dist.mjs
```

就这一步。`dist/` 是 NAS 共享目录，nginx 直接读它，**不需要重启任何服务**，
**不需要重启 nginx**。刷新页面即生效。

脚本做四件事：

1. 全量重建 `dist/`（删掉上版的残骸，避免删掉的文件还在）
2. 按白名单复制 10 个文件
3. 写 `dist/BUILD.txt`（构建时间 + 每个文件的 sha256 短哈希）
4. **自检 `index.html` 引用到的资源是否都在白名单内**，缺文件直接报错退出

> 第 4 步是硬门禁：引用了不在白名单里的资源就是线上白屏
> （而且只在浏览器控制台报错，很难第一时间发现）。加新文件时
> **同时改白名单和 `index.html`**，只改一处会被它挡住。

`dist/BUILD.txt` 留在产物里，线上排查时能直接确认「服务器上的到底是哪一版」：

```bash
curl -s https://home.xiaokubao.space/schedule/BUILD.txt
```

### 白名单构成

`index.html` `styles.css` `store.js` `parse.js` `views.js` `clock.js` `app.js`
`sw.js` `manifest.json` `icon.svg` —— 10 个，一个不多一个不少。

> **少一个文件应用就缺功能，多一个文件就是信息泄露**（源码、项目记忆、计划文档会跟着上线）。
> 所以是白名单而不是「排除法」。

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
    ├── balancebook.conf   ← 个人账本（可以照抄它的结构）
    └── schedule.conf      ← 本项目，本地副本在 deploy/schedule.conf
```

| 目录 | 放什么 | 要 include 吗 |
|---|---|---|
| `global/` | 全局都生效的设置 | 自动 |
| `servers/` | server 块（域名级） | 自动 |
| `common/` | 可复用的片段 | 用到才 include |
| `home/` | 本域名的 location | **必须**在 `servers/home.conf` 加一行 |

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

本项目只有一个文件，42 行。**照着改，别新造轮子。**

完整内容见 `deploy/schedule.conf`（本地副本）。服务器上真正生效的那份在
`~/docker/nginx/conf.d/home/schedule.conf`。

```nginx
# 补斜杠
location = /schedule { return 301 /schedule/; }

# 本地目录不对外提供
location ^~ /schedule/_refactor/    { return 404 "not found"; }
location ^~ /schedule/src/         { return 404 "not found"; }
location ^~ /schedule/tools/       { return 404 "not found"; }
location ^~ /schedule/node_modules/ { return 404 "not found"; }
location ^~ /schedule/.workbuddy/   { return 404 "not found"; }

# Service Worker
location = /schedule/sw.js {
    alias /data/schedule/dist/sw.js;
    add_header Cache-Control "no-store, must-revalidate" always;
    expires off;
}

# 应用本体
location ^~ /schedule/ {
    alias /data/schedule/dist/;
    index index.html;
    add_header Cache-Control "no-cache";
    access_log off;
}
```

### 五条要记住的

1. **`^~` 不能省。** 少了它，`location ~` 的正则会抢在前面匹配，
   `dist/` 里的文件名会被别的正则 location 截走。

2. **location 顺序不能颠倒。** `location = /schedule/sw.js`（精确）必须写在
   `location ^~ /schedule/`（前缀）**前面**。`^~` 一旦先匹配，
   后面的精确块就失效 —— 那时 SW 会落到通用前缀块里，缓存策略全丢。

3. **用 `alias` 不用 `root`。** 项目目录是**整个**挂到 `/data/schedule` 的
   （不只 `dist/`），`root` 会把 `/schedule/` 拼成 `/data/schedule/schedule/`。

4. **缓存策略与账本相反。** 见下面 4.1，这是最容易照抄错的一条。

5. **只对外提供 `dist/`。** 源码、`_refactor/`、`tools/`、`node_modules/`、
   `.workbuddy/` 一律 404。

### 4.1 缓存策略：本项目 vs 账本，**别照抄**

| 路径 | 本项目 | 账本 | 原因 |
|---|---|---|---|
| `index.html` / `app.js` / `styles.css` | **`no-cache`** | `no-cache` | 两边一致 |
| 哈希资源 `assets/` | 不存在 | `expires 1y` | 账本构建产物带内容哈希 |
| `sw.js` | **`no-store, must-revalidate`** | 同 | 一致 |

**本应用的文件名是固定的**（`app.js` / `styles.css`，没有内容哈希），
所以**绝对不能长缓存** —— 否则改了代码用户永远拿不到新版。
账本的 `assets/index-XXXX.css` 带哈希才能 `expires 1y`，那是 Vite 构建才有的性质。

`sw.js` 必须 `no-store`：被缓存的 SW 会一直发旧版本的 `app.js` / `styles.css`。

> **`no-cache` 不是「不缓存」。** 它仍然缓存，只是每次用前必须回源校验。
> `no-store` 才是完全不存。前者对 200 KB 的静态文件完全够用。

### 4.2 `/schedule` 无尾斜杠必须显式 301

少了尾斜杠时，页面里的相对路径（`store.js`、`styles.css`）会解析到
`/store.js` 而不是 `/schedule/store.js` → **直接白屏**。
nginx 不会自动补斜杠，必须显式 `return 301`。

---

## 五、与现行结构的适配（最容易照抄错的地方）

### 5.1 本项目没有接口，也没有版本号

**没有 `/api/*`，没有 `v1` / `v2` / `v3`。** 账本那套「静态旧路径 301、
接口旧路径 410」的规则在这里**一条都不适用** —— 本项目从来没有接口路径，
历史请求只有静态文件，而静态文件改过名就是新路径，没有「跳回当前版」的必要。

数据在浏览器 localStorage（key `schedule-app-v1`），**不上传服务器**。
`v1` 那个后缀是本地存储 key 的一部分，与版本化无关。

### 5.2 源码隔离靠白名单脚本，不靠 nginx 逐条列举

账本用 Vite，`public/` 里的任何东西都会被原样拷进 `dist/`，
所以 nginx 需要一条兜底 `location ^~ /balancebook/. { return 404; }`。

本项目没有 Vite，`dist/` 由 `sync-dist.mjs` 按白名单生成 —— 
**`dist/` 里本来就只有那 10 个文件**，nginx 只需挡住
源码目录（`_refactor/` / `tools/` / `node_modules/`）即可。

> **加文件时只改一处会被门禁挡住**：改了 `index.html` 忘了加白名单，
> `sync-dist.mjs` 报错退出；改了白名单忘了改 `index.html`，多出的文件不构成泄露
> 但会白白占位。**以 `sync-dist.mjs` 的报错为准。**

### 5.3 「刷新即生效」的前提

nginx 直挂项目目录，**没有上传步骤**。但：

- **只对 `dist/` 生效。** 改完源码必须 `node tools/sync-dist.mjs`，
  否则页面纹丝不动 —— 这是最常见的「改了没反应」。
- **Service Worker 可能挡着。** 排查时先注销
  （见 [CLAUDE.md](CLAUDE.md) 「四、1」）。
- **SMB 有写入延迟。** 刚写完立刻读可能读到旧内容。
  `sync-dist.mjs` 每次全量重建 `dist/`，一般不会碰到；
  真碰到了等几秒重跑。
- **缓存策略已经分层**，绝大多数情况不需要手动清缓存。

### 5.4 改 `index.html` 或 `sw.js` 才要动 `CACHE`

本应用无内容哈希，改 CSS/JS **也会**撞到 SW 缓存里 —— 但因为是
网络优先，刷新就会拿到新版。所以平时**不需要**改版本号。

只有改了 `index.html` 或 `sw.js` 本身时，才把 `sw.js` 里的 `CACHE`
（现在 `schedule-v12`）加一，让 `activate` 里删旧缓存那步触发。

> **别把版本号当成「每次发布都要加」的仪式。** 账本因为构建产物带哈希才需要
> 每次核对 `VERSION`，本项目没这层机制。

---

## 六、发布流程

```bash
cd /mnt/fnos/family/星星包/coding/日程管理
node tools/sync-dist.mjs        # 唯一的发布动作
```

**没有部署脚本。** 账本那个七步的 `deploy.sh` 是给有后端的项目用的
（备份数据、构建、重建镜像、等 healthcheck、验证路由），
本项目没有后端、没有数据、没有构建，两步就完了：

```text
1. 改代码
2. node tools/sync-dist.mjs   →  dist/ 变了，刷新页面即生效
```

**只有改 nginx 配置时才是三步**：

```bash
# 1. 改 deploy/schedule.conf（本地副本，保持两边一致）
# 2. 同步到服务器生效的那份（这台机器就是服务器，直接 cp）
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
# 3. 校验 + 重载
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

> **改之前先备份**：`cp -p <目标> <目标>.bak-$(date +%Y%m%d-%H%M%S)`。
> 服务器上已有 `schedule.conf.bak-20261005-153546` 等历史备份。

> **从别的机器改时**用管道而不是 `scp`（中文路径下 `scp` 不可靠，见第七节）：
> ```bash
> cat deploy/schedule.conf | ssh ubuntu "cat > ~/docker/nginx/conf.d/home/schedule.conf"
> md5sum deploy/schedule.conf
> ssh ubuntu "md5sum ~/docker/nginx/conf.d/home/schedule.conf"
> ```
> `~/.ssh/config` 里的别名是 **`ubuntu`**（也是 `fn`），**没有 `nas`** ——
> 那是从 Windows 连过来时的名字。在本机上写 `ssh nas` 会报
> `Could not resolve hostname nas`。

### 6.1 验证线上

```bash
B=https://home.xiaokubao.space/schedule
for p in "/" "/sw.js" "/BUILD.txt" "/styles.css" \
         "/_refactor/" "/src/" "/tools/" "/tests/" "/deploy/" \
         "/node_modules/" "/.workbuddy/" "/DEPLOY-PLAN.md"; do
  printf '%-18s %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' $B$p)"
done
```

期望输出（2026-10-05 实测）：

```text
/                      200
/sw.js                 200
/BUILD.txt             200
/styles.css            200
/_refactor/            404     ← React 骨架不对外
/src/                  404
/tools/                404     ← 本地脚本不对外
/tests/                404     ← 测试脚本含本机绝对路径
/deploy/               404     ← conf 副本不对外
/node_modules/         404
/.workbuddy/           404
/DEPLOY-PLAN.md        404
```

> `curl` 加 `-k`：证书链在部分环境下校验不过，加了不影响看状态码。

再确认缓存头：

```bash
curl -skI $B/sw.js       | grep -i cache-control   # no-store, must-revalidate
curl -skI $B/index.html  | grep -i cache-control   # no-cache
curl -skI $B/app.js      | grep -i cache-control   # no-cache
```

再确认补斜杠：

```bash
curl -sk -o /dev/null -w '%{http_code} -> %{redirect_url}\n' $B
# 301 -> https://home.xiaokubao.space/schedule/
```

### 6.2 抽查既有站点

改了 compose 或 reload 之后，确认没打断别人：

```bash
for p in "/" "/balancebook/" "/docker/" "/mindfs/" "/hermes/"; do
  printf '%-16s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://home.xiaokubao.space$p")"
done
```

---

## 七、回滚

| 故障 | 回滚动作 |
|---|---|
| 应用新版有问题 | 把 `dist/` 恢复成上一版文件，刷新即生效（无构建产物可回滚，就是覆盖文件）。`dist/BUILD.txt` 里有每个文件的哈希，可确认版本 |
| 想临时下线 | `conf.d/home/schedule.conf` 改名 `.conf.disabled` → `nginx -t && reload` |
| nginx 整体起不来 | 恢复备份：`docker-compose.yml.bak-<时间戳>` 与 `conf.d/servers/home.conf.bak-<时间戳>`，再 `docker compose up -d` |

> **2026-10-05 上线时的备份留在服务器上**：
> `docker-compose.yml.bak-20261005-140134`、
> `conf.d/servers/home.conf.bak-20261005-140134`。

---

## 八、环境踩坑

**8.1 `scp` 传中文路径报 `pipe: Unknown error`**

从 Windows 连过来时 `scp` 传含中文的路径会失败。改用：

```bash
cat 本地文件 | ssh ubuntu "cat > 目标路径"
# 然后 md5sum 校验两端一致
```

**8.1b 这台机器上没有 `nas` 这个 SSH 别名**

`~/.ssh/config` 里本机叫 **`ubuntu`**（`HostName home.xiaokubao.space`），
也有 `fn` 指同一台。`nas` 是 Windows 侧用的名字。
**在本机上执行 `ssh nas` 会报 `Could not resolve hostname nas`。**

而且 —— **这台机器（`192.168.1.6`，`ubuntu`）就是 nginx 所在的那台**，
`ssh` 到自己没必要，改配置直接：

```bash
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

**8.2 Git Bash 自带的 ssh 不读该配置**

要用 Windows 版 OpenSSH（`C:\Windows\System32\OpenSSH\ssh.exe`），
或在 Git Bash 里自己写 `Host nas` 配置。

**8.3 `docker run ... nginx -t` 报 invalid option**

该镜像 entrypoint 已是 nginx，改用 `docker exec nginx nginx -t`。

**8.4 无头 Chrome 有最小窗口宽度约 526px**

`--window-size=390` 实测 `innerWidth` 是 526，量不到真手机宽度。
**用固定宽度的 iframe 包住应用**才是真视口。其余测试坑见
[CLAUDE.md](CLAUDE.md) 「四、21」—— 那些是照抄级清单。

---

## 九、故障排查

| 现象 | 查什么 |
|---|---|
| 改了代码但页面没变 | **先确认跑过 `node tools/sync-dist.mjs`**（nginx 只挂 `dist/`）；再清 Service Worker，见 [CLAUDE.md](CLAUDE.md) 「四、1」 |
| 改了源码 `dist/` 里的文件还是老的 | 跑同步脚本。直接改 `dist/` 会被下次同步覆盖 |
| 页面 404 | `servers/home.conf` 里忘了 `include` `schedule.conf` |
| 页面能开但资源全 404 | `alias` 写错了，或容器没重建（加挂载必须 `docker compose up -d`，不能 reload 绕过） |
| 白屏 + 资源 404 | 访问的是 `/schedule`（无尾斜杠），相对路径解析到了 `/store.js`。用 `/schedule/` |
| SW 挡着拿不到新版 | 强刷（Ctrl+Shift+R），或在 DevTools → Application → Service Workers 里 Unregister |
| `sync-dist.mjs` 报错退出 | `index.html` 引用了不在白名单里的资源 —— 白名单和 `index.html` 要同时改 |
| nginx 改完不生效 | 忘了 `nginx -t`，或者忘了 reload，或者忘了 include |
| 证书快过期 | 三·3.4，**没有自动续期**，全站共用 |
| 手机装成 App 后霸占整站 | PWA `scope`，见 [CLAUDE.md](CLAUDE.md)（本项目 `manifest.json` 的 `scope` 是 `./`，已锁在 `/schedule/`） |

---

## 十、相关文档

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 数据模型、代码约定、踩坑记录（**改代码前先读**） |
| [README.md](README.md) | 怎么用、数据在哪、日常命令 |
| `deploy/schedule.conf` | nginx 配置的本地副本（服务器上还有一份） |
| `tools/sync-dist.mjs` | 白名单 + `BUILD.txt` 生成脚本，文件头有完整说明 |
| `/home/xiaokubao/docker/nginx/conf.d/README-hosts.md` | 全站域名 ↔ 设备 ↔ 路径的映射表 |
| `/home/xiaokubao/docker/nginx/conf.d/home/balancebook.conf` | 账本的 conf，写 location 时可对照（有后端项目，比本项目多一段 `proxy_pass`） |