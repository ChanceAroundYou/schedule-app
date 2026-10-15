# 部署 · conf 怎么写

> **五份运维文档**：拓扑与上线 → [DEPLOY.md](DEPLOY.md)；nginx 怎么操作 →
> [DEPLOY-nginx.md](DEPLOY-nginx.md)；conf 怎么写 → [DEPLOY-conf.md](DEPLOY-conf.md)；
> 发布 / 回滚 / 结构适配 → [DEPLOY-运维.md](DEPLOY-运维.md)；环境踩坑与故障排查 →
> [DEPLOY-排障.md](DEPLOY-排障.md)。**章节号沿用原来的，交叉引用不用改。**


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
    alias /data/schedule-web/assets/;
    expires 1y;
    add_header Cache-Control "public, immutable";
}

location ^~ /schedule/ {                                  # 应用本体
    alias /data/schedule-web/;
    index index.html;
    add_header Cache-Control "no-cache";
}
```

> 2026-10-15 之前这两个 alias 指向 `/data/schedule/dist/`（＝ SMB 工程目录里
> 的构建产物），**本地 build 一下就等于上线**。现在指向 `/data/schedule-web/`，
> 那是本机磁盘上的发布目录，只有 `deploy/publish-web.sh` 会动它。

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

4. **用 `alias` 不用 `root`。** 挂进来的是 `~/.local/share/schedule-web`，
   `root` 会把 `/schedule/` 拼成 `/data/schedule-web/schedule/`。
   （2026-10-15 之前挂的是整个工程目录 `/data/schedule`，同一个道理。）

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
| `/schedule/api/ai/chat` | `no-store` **+ 关 buffering** | 单独一块，见 4.4 |

> 旧版（纯静态那一代）**整套**都得 `no-cache`，因为那时候 `app.js` /
> `styles.css` 的文件名固定、没有哈希。现在只有 `index.html` 需要了 ——
> 别再照抄旧结论。

> `no-cache` 不是「不缓存」。它仍然缓存，只是每次用前必须回源校验。
> `no-store` 才是完全不存。

### 4.4 AI 对话那条单独开一块（SSE）

`/schedule/api/ai/chat` 走 SSE 流式返回。父块 `^~ /schedule/api/` 的两个默认值
会**把流掐死**，所以必须另起一块（`deploy/schedule.conf` 里紧跟在父块后面）：

```nginx
location ^~ /schedule/api/ai/chat {
    proxy_pass http://127.0.0.1:25692/api/ai/chat;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_set_header Connection "";
    add_header Cache-Control "no-store" always;
}
```

| 那一条 | 不写会怎样 |
|---|---|
| `proxy_read_timeout 300s` | **实测过**：父块的 30s 会让上游静默超过 30 秒的那一轮直接 **504**（造了个静默 35 秒的上游，走父块配置 30.03s 就 504；改 300s 后 35.04s 正常拿到数据）。一轮带工具调用的问答很常见这种静默 |
| `add_header …` | **实测过**：**不写就没有 `no-store`**。`add_header` 只在「同一层没写过」时才继承上一层的 —— `^~ /schedule/api/ai/chat` 和 `^~ /schedule/api/` 是**同层的两个 location**，不是父子，所以父块那条根本传不过来 |
| `proxy_http_version 1.1` + `Connection ""` | keep-alive 会让 nginx 攒着等下一段，头几段迟迟不出去。**没用独立用例量过**，是 SSE 的标准写法 |
| `proxy_buffering off` | **这条要老实说**：在本机 nginx 1.29.8 上，开着和关着**量不出差别**（4 条事件隔 1 秒，两种配置都是逐块在 1 秒上下到达）。所以它不是「不写就完全没流式」。留着是因为它在 payload 变大、或链路里开了 gzip 时会咬人 —— 属于标准写法的预防，不是本机验出来的必要项 |

> 验的时候是这么做的：在 nginx 容器里**另起一个测试实例**（`nginx -c` 指一份
> `/tmp` 下的完整配置，独立 `pid` 文件），把 `^~ /schedule/api/ai/chat` 和
> `^~ /schedule/api/` 两块的前缀原样抄过去、`proxy_pass` 指向两个不同的回声端口，
> 看到 `/schedule/api/health` 打到 25901、`/schedule/api/ai/chat` 打到 25902 ——
> **最长前缀胜出这条是证过的**，不是照抄文档。全程没碰线上那份 conf。
>
> 前缀更长所以这块赢，两块都是 `^~`，先后顺序无所谓。
> 改完照 2.3 走：`cp` → `docker exec nginx nginx -t` → `nginx -s reload`。

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
