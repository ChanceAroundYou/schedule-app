# 日程清单 · 部署与运维

一台 Ubuntu（`192.168.1.6`，SSH 别名 **`ubuntu`**）：nginx 容器伺服前端并反代
`/schedule/api/`，后端是宿主机上的 systemd user 服务（Node 22，只听 127.0.0.1:25692）。
命令都在这台机器上实测过，路径照抄即可。

改路由、改缓存策略之前先读「conf 要点」和「排障 · 环境踩坑」——那几条每条都是踩坑换来的。

---

## 一、拓扑与目录

**本文所有 `~/` 都是指服务器 `ubuntu`（`192.168.1.6`）上的家目录**，不是 NAS 本机
（`xiaokubao-fn`，`192.168.1.4`）—— 两边都有个 `~/.local/schedule/`，NAS 上那个是
**2026-10-23 的旧残留**（`web/` 里 index.html 的 md5 和线上那份不一样），线上不读它。
在 NAS 上跑命令前先想清楚「这是在哪台机器上」。

```text
公网 → Cloudflare 隧道（路由器上）→ home.xiaokubao.space 直达 ubuntu
  │
  ▼
nginx 容器（network_mode: host）
  /schedule/      → /data/schedule-web/    静态，只读挂载
  /schedule/dl/   → /data/schedule-apk/    App 自更新的安装包
  /schedule/api/  → 127.0.0.1:25692        反代后端
                                             │
                                             ▼
                          ~/.local/schedule/data/schedule.db
```

线上这套东西**全在一个目录里**：

```text
~/.local/schedule/
├── web/    前端线上产物（dist/ 的拷贝）    → 容器 /data/schedule-web:ro
├── app/    后端线上代码（server/ 的拷贝）  → 容器 /data/schedule-app:ro
├── data/   SQLite 库 + secret.key        （不进容器）
├── deps/   后端依赖 112 MB               （不进容器）
└── apk/    App 自更新包 + version.json    → 容器 /data/schedule-apk:ro
```

⚠️ **工程目录不再挂进容器**，源码对外一律 404（`/schedule/server/server.js` 应返回 404）。

| 路径 | 内容 |
|---|---|
| `/home/xiaokubao/.local/schedule/{web,app,data,deps,apk}` | 见上表 |
| `/home/xiaokubao/docker/nginx` | nginx 的 compose（`deploy/nginx-compose.yml` 是副本）+ `conf.d/` + `certs/` |
| 工程目录 `/vol2/@team/family/星星包/coding/日程管理`（NAS 本机）/ `/mnt/fnos/…`（经 SMB 看） | **只是源码**，线上不读它 |

| | 前端 | 后端 |
|---|---|---|
| 是什么 | Vite 构建产物 | Node 22 + node:sqlite |
| 谁在伺服 | nginx 容器 | systemd user 服务 |
| 端口 | 无 | 127.0.0.1:25692 |
| 改完怎么生效 | `./deploy/publish-web.sh` | `./deploy/publish-server.sh` |
| 挂了会怎样 | 白屏 | 页面能开，接口全 404、登录不上 |

> ⚠️ **`npm run build` 不等于上线**。工程里的 `dist/` 只是本地产物
> （`browser-cards.mjs` 这类探针要用），线上读的是 `~/.local/schedule/web/`。

### 数据与备份

`SCHEDULE_DATA_DIR=/home/xiaokubao/.local/schedule/data`，里面就三样：
`schedule.db`（+ `-wal` / `-shm`）、`secret.key`（令牌签名密钥，0600）。

放本机磁盘而不是工程目录，是因为工程目录**经 SMB 共享给 Windows**，SQLite 的文件锁在
SMB 上不可靠，写了坏页不可恢复。

```bash
systemctl --user stop schedule-backend     # 先停，WAL 才干净落盘
cp -a ~/.local/schedule/data ~/schedule-backup-$(date +%Y%m%d)
systemctl --user start schedule-backend
```

> `secret.key` 丢了 = 所有人被登出（令牌验不过），数据不受影响。
> `schedule.db` 丢了 = 数据没了（用户还能从侧栏「导出备份」的 JSON 里救回来）。

### 后端依赖

AI 那一组（`@earendil-works/pi-agent-core` + `pi-ai`，锁精确版本 `1.0.4`）是唯一
允许的第三方依赖，**只装在本机磁盘**，靠软链指过去：

```bash
./deploy/install-deps.sh                   # 首次安装 / 换机器
ln -s ~/.local/schedule/deps/node_modules ./node_modules   # 每份 checkout 都要补
```

| 为什么是这样 | |
|---|---|
| 软链不用 `NODE_PATH` | 不用改 systemd 单元，也不挑进程从哪个目录起 |
| `node_modules` 在 `.gitignore` 里 | 链不进版本库，每份 checkout 自己补。缺了服务**照样起得来**（`lib/ai/index.js` 是惰性 import），只是 AI 页报「依赖没装好」 |
| pi 的 import 只出现在 `server/lib/ai/` 下（现 8 个文件） | 目录之外的代码永远不碰第三方包；升版改动收敛在这一个目录里 |

---

## 二、双端开发与生产锁定

**两侧都在推进开发，两边都能看到同一个仓库** —— 所以「哪份代码是线上跑的」
不能靠记忆，得靠结构保证。

```text
Windows 本机    C:\Users\小哭包\coding\schedule-wt        分支 dev   → github/dev
ubuntu 侧工程目录（NAS 的 /vol2/… 经 SMB 挂成 /mnt/fnos/…）  分支 main → origin/main
        │                                                    │
        └──────────── 同一个 upstream ───────────────────────┘
                  github.com/ChanceAroundYou/schedule-app
                                  │
                     只有 publish-*.sh --approve 能写
                                  ▼
        生产  ubuntu:~/.local/schedule/{web,app}   （服务器本机磁盘）
```

| | Windows 本机 | ubuntu 工程目录 |
|---|---|---|
| 路径 | `C:\Users\小哭包\coding\schedule-wt` | `/mnt/fnos/family/星星包/coding/日程管理`（NAS 本机即 `/vol2/@team/family/星星包/coding/日程管理`） |
| 分支 | **`dev`** | **`main`** |
| remote 名 | `github` | `origin` |
| 上游 | `github/dev` | `origin/main`（同一个仓库，名字不同而已） |
| 生产可读性 | 写不到 `~/.local/schedule/` | 同样写不到（不在容器挂载里） |

三条约定：

1. **两侧各推各的分支，互不干扰。** dev ↔ main 的合流**由你手动做**，没有自动同步、
   没有 CI。合的时候冲突先摆出来给你挑，不替你选。
2. **生产不开独立分支。** 线上跑哪个版本记在 `~/.local/schedule/state/*.version`
   里（含 commit sha 和来源分支），追溯靠它，不靠分支。
3. **发布必须你授权。** 两个脚本默认 dry-run，见下。

### 生产锁定是怎么成立的

四道，从强到弱：

| 层 | 保证 |
|---|---|
| 物理隔离 | 生产在服务器本机磁盘 `~/.local/schedule/`，不是 SMB 共享目录 —— 两侧工作区**都写不到**，别的设备也碰不到 |
| 容器隔离 | 工程目录不挂进 nginx 容器，`/schedule/server/server.js` 返回 404 |
| 唯一写入口 | 只有 `deploy/publish-web.sh` / `publish-server.sh` 会写生产，且**默认 dry-run**（退出码 1 = 未授权） |
| 可追溯 | 发布前体检分支/HEAD/工作区状态；发布后写 `state/*.version` |

### 发布授权流程

```bash
# 1. 先提交 + 推送（闸门会查这两项）
git add <本任务的文件> && git commit && git push
```

> **别写 `git add -A`。** 两个会话（Windows 的 `dev` / 这里的 `main`）共用同一份
> 工作副本时，`-A` 会把别人的在途改动一起卷进你的提交。逐条 add 本任务的文件，
> 规则见 [docs/工作区保护.md](docs/工作区保护.md)。

```bash
# 2. dry-run —— 只打印「要发什么 / 来源分支哪个提交 / 发到哪」，一个字节都不写
./deploy/publish-web.sh
./deploy/publish-server.sh

# 3. 确认上面都对，才授权
./deploy/publish-web.sh --approve
./deploy/publish-server.sh --approve
```

| 参数 | 作用 |
|---|---|
| _（不带）_ | **dry-run**：只看不写，退出码 **1**（不是 0 —— 这样 `a.sh && b.sh` 漏写 `--approve` 会当场停住，不会一路跑到发布） |
| `--approve` | 真的发布 |
| `--force` | 忽略内容指纹，强制重发一遍 |
| `--skip-build` | 仅 web：不重新构建，用现有 `dist/` |
| `--rollback` | 回滚到上一份备份（**也要 `--approve`**） |
| `--allow-dirty` | 逃生口：允许带着未提交改动发布 |
| `--allow-unpushed` | 逃生口：允许带着未推送的提交发布 |

**开关顺序无所谓**（2026-10-25 起全部在 `preflight.sh` 的 `pf_parse_args` 里扫全量），
拼错的 `--xxx` 会当场报错退出，不会静默忽略。

> ⚠️ **2026-10-25 之前这里是个事故点**：`--rollback` / `--skip-build` 当时只认第一个
> 参数，而 `--approve` 扫全量 —— 于是 `--approve --rollback` 不进回滚分支，**一路走到
> 「构建 → 授权 → 发布」**：以为在回滚，实际在上线，而且不报错。现在两个开关和
> `--approve` 走同一个循环，别再改回 `[ "$1" = ... ]`。

⚠️ 两个逃生口意味着「线上跑的版本**对不上仓库里任何提交**」—— 排障时
`state/*.version` 里那个 commit 会误导你。救急才用，用完尽快补提交推送。

### 线上现在跑的是什么

```bash
ssh ubuntu 'cat ~/.local/schedule/state/*.version'
```

写成 `target=web` / `version=` / `commit=` / `branch=` / `published_at=` /
`published_from=` 这么几行。**格式示意，别照抄** —— 实际值以命令输出为准。

> ⚠️ 刻意**不放在 `web/` 里**：那是 nginx 站点根，放进去就等于在
> `https://…/schedule/VERSION` 上公开版本号和 commit sha。`state/` 不在任何容器挂载里。

### 分支现状

`dev` 已于 2026-10-25 整条合并进 `main`。**别信文档里的数字**，查一条命令：

```bash
git rev-list --left-right --count origin/dev...HEAD   # 左 = dev 独有，右 = main 领先
```

合流仍由用户手动做 —— 冲突时先摆差异，不替他挑。

---

## 三、发布

### 3.0 一键闭环（日常用这两个，不要手工串 publish-*.sh）

```bash
./deploy/web-loop.sh       # 网页端：可追溯 → tsc → 单测 → 本地深测 → 发布 → 线上实测
./deploy/mobile-loop.sh    # 手机端：+版本号自检 → 打包 → 发布 → 装机 → 真机冒烟
```

两者都会逐段检查、失败退出码非 0（调用方自动返工），结尾给实测结论。
publish-*.sh 仍然可以直接用，但**必须自己先做完体检**。

⚠️ **发布前的工作区保护**（多人/多会话并行时的硬性前置，见
[docs/工作区保护.md](docs/工作区保护.md)）：

```bash
git status --porcelain     # 必须为空（或已 stash -u / WIP 分支存档）
git stash list             # 有半成品要记住编号，写进当天 memory
git ls-files -u            # 必须为空（不能在冲突中发布）
git log @{u}.. --oneline   # 必须为空（改动要先推到 dev）
```

**不要用 `--allow-dirty` / `--allow-unpushed` 绕过体检** —— 那会让线上版本
对不上任何提交。真遇到「脏文件全在发布路径之外」（例如 `deploy/` 下的草稿脚本）
才可以用 `--allow-dirty`。

### 3.1 单独用发布脚本

```bash
./deploy/publish-web.sh        # 前端：构建 → 上传 → 备份 → 切换 → 回读校验
./deploy/publish-server.sh     # 后端：拷代码 → 备份 → restart → 探活
./deploy/publish-apk.sh "说明" # 原生层（小组件 / 权限 / 图标）必须换 APK 才生效
```

**两个 web/server 脚本都先比内容指纹**（逐文件 sha256 汇总，只看内容不看 mtime）：
一样就打印「无变更 → 跳过」、只做一次回读/探活然后退出 —— **不上传、不备份、不重启**。
所以重跑脚本是安全的。要强制重发加 `--force`。两者都支持 `--rollback`。

```bash
./deploy/publish-web.sh --skip-build --approve    # 已有同源 dist/，只发布
./deploy/publish-web.sh --rollback --approve      # 拷回最新那份**发布**备份（留最近 3 份）
./deploy/publish-server.sh --rollback --approve
```

> **回滚挑备份时会排除 `-rollback-` 快照**（`pf_rollback_candidates_cmd`）。回滚自己也
> 会写一份 `web.bak-rollback-*`（= 刚退掉的那一版），按 mtime 挑的话第二次回滚会把它
> 挑回来 —— 用户敲的命令和第一次一模一样，结果却是「退回了坏版本」，看不出任何区别。
> 代价是**回滚对下一次发布之前是幂等的**：连按三次都停在同一个版本。想再退一级得从
> 打印出来的候选列表里手动拷。

⚠️ 五条不能破的实现约束：

1. **只换目录里的东西，绝不 `mv` 目录本身。** Docker 的 bind mount 认 **inode**：
   目录被 mv 走后容器里那个挂载点还指着已删除的旧 inode，nginx 立刻 403
   `directory index forbidden`，**重启容器前不会自愈**。
2. **指纹命令里那道 `sed 's/\*//g' | tr -s ' '` 别删。** Git Bash 的 `sha256sum`
   走二进制模式输出 `HASH *路径`，Linux 上是文本模式输出 `HASH  路径`；不归一化的话
   两边算同一批文件也得出不同指纹，跳过逻辑形同虚设。
3. **`app/node_modules` 软链只在 `[ ! -e node_modules ]` 时补**（`-e` 对悬空软链为假，
   正好覆盖「链还在、目标没了」）。它**不是重装依赖** —— 本体在 `deps/`，只在
   `install-deps.sh` 装一次。
4. **打包时强制 `--mode='u+rwX,go+rX'`，解包后再 chmod 一次并数文件数**（2026-10-24）。
   工程目录经 SMB 共享，`dist/` 出来就是 `055`：tar 照原样带过去，远端先建出 `assets/`
   （没有写位）再往里塞文件就 `Permission denied`，`cp -r` 也读不动 —— 以前每次靠手动
   `chmod -R 755` 补救。文件数对不上会当场报「解包后只有 N 个」，不会再静默少文件。
5. **回读校验以服务器磁盘上那份 `index.html` 为准**，公网那一趟只当链路体检（不一致只提示）。
   以前只从公网抓 HTML 再 grep，「服务器已经是新的、公网还是旧的」也报「没生效」——
   假阴性，每次都得手动 `grep` 一遍。**用户端不用清缓存**：`sw.js`（`sched-shell-v4`）
   导航走网络优先，只有带哈希的 assets 缓存优先，`data/update-guard.ts` 比 bundle 名不一致会提示刷新。

### APK 自更新

| | |
|---|---|
| **versionCode 必须手加** | `app/android/app/build.gradle`。客户端只认「服务端大于自己才提示」，忘了加就永远收不到更新 |
| **签名不可换** | keystore 在 `C:/Users/小哭包/.android/schedule-release.jks`，密码在 `app/android/keystore.properties`（gitignore）。换 keystore = 覆盖安装失败 |
| **首次从 debug 切 release 要卸载一次** | 签名不同，`adb install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。数据在服务器上，重装登录即回 |
| **发了坏包** | 把 `~/.local/schedule/apk/version.json` 改回上一个 versionCode，或直接删掉 version.json —— 客户端拉不到清单就静默不提示 |

---

## 四、改配置怎么生效

**nginx**：

```bash
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

- 用 `docker exec`，**不要 `docker run ... nginx -t`** —— 该镜像 entrypoint 已是 nginx，
  传 `nginx -t` 会报 `invalid option`。
- `-t` 不通过就别 reload：容器里的配置是直接挂进去的，改坏会把同机所有站点一起带下去。
- 容器里只有 `conf.d/global/*.conf` 与 `conf.d/servers/*.conf` 被自动 include；
  **`conf.d/home/` 下的文件必须同时在 `servers/home.conf` 里加一行 `include` 才生效**
  —— 这是最容易踩的一步。
- 停用一个站点：把 `.conf` 改名 `.conf.disabled`（include 只匹配 `*.conf`）。

改 `deploy/schedule.conf`（本地副本）后：

```bash
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

改了 compose 挂载就要重建：`docker compose up -d --force-recreate`
（`up -d` 在 compose 没变时不会真重建）。

**systemd 单元**：

```bash
cp deploy/schedule-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user restart schedule-backend
```

这台机器开了 linger（`loginctl show-user xiaokubao` → `Linger=yes`），用户级服务注销后
照样活着 —— **换机器要先确认这一条**。单元里 `ExecStart` 钉死了 nvm 的
`node v22.22.3`，**别改成 `/usr/local/bin/node`**（那是指向 22.16 的软链，`node:sqlite`
在 22.16 上还要 `--experimental-sqlite`）。

**库结构升版前先备份**（见「数据与备份」）。`server/lib/db.js` 的 `user_version`
对不上时：空库 → 推倒重建；有账户的库 → 逐版执行 `MIGRATIONS`（只 CREATE / ALTER，
绝不 DROP）。没有对应迁移时会直接 `throw` 拒绝启动 —— 这是刻意保留的保护，
**别去手改库里的版本号**。`server/tests/migration.test.js` 是全项目唯一「跑错会吃掉
用户数据」的代码。

---

## 五、conf 要点

完整内容见 `deploy/schedule.conf`（132 行）。骨架：

```nginx
location = /schedule { return 301 /schedule/; }        # 补斜杠
location ^~ /schedule/api/ { proxy_pass http://127.0.0.1:25692/api/; ... }
location ^~ /schedule/app/     { return 404 "not found"; }   # 源码
location ^~ /schedule/server/  { return 404 "not found"; }
location ^~ /schedule/legacy/  { return 404 "not found"; }
location ^~ /schedule/.        { return 404 "not found"; }   # 点开头的内务
location ^~ /schedule/assets/  { alias /data/schedule-web/assets/; expires 1y; ... }
location ^~ /schedule/         { alias /data/schedule-web/; index index.html; ... }
```

六条要记住的：

1. **`^~` 不能省。** 少了它，`location ~` 的正则会抢在前面匹配。
2. **`/schedule/api/` 与 `/schedule/` 两块都得是 `^~`。** nginx 在多个 `^~` 里选最长的，
   先后顺序无所谓；但两块都带 `^~` 才成立，否则 API 请求会落进静态块 404。
3. **`location /schedule/.` 写成前缀块，别写正则。** 上面那些 `^~` 一旦命中就停止正则
   匹配，正则块永远不会求值（死代码）。前缀是字面量，能覆盖 `.git/` `.omc/` `.claude/` 等。
4. **用 `alias` 不用 `root`。** `root` 会把 `/schedule/` 拼成 `/data/schedule-web/schedule/`。
5. **那一串 404 是第二道锁。** `alias` 本身已经隔离了源码，加上它们是防止以后有人改成
   `root` 指向项目根时源码裸奔（`server/` 里有 SQLite 库和 `secret.key`）。
6. **`proxy_pass` 结尾的 `/api/` 不能丢。** 带了 URI 部分 nginx 才会替换匹配前缀，
   少了它后端会收到带 `/schedule` 前缀的路径，全是 404。

### 缓存三档，别混

| 路径 | 策略 | 原因 |
|---|---|---|
| `/schedule/assets/*` | `expires 1y` + `immutable` | 产物带内容哈希，内容一变文件名就变 |
| `/schedule/index.html` | `no-cache` | 文件名固定，否则用户被钉在旧版本上 |
| `/schedule/api/*` | `no-store` | 带 Authorization 的响应被中间层存下来就是事故 |

> `no-cache` 不是「不缓存」—— 它仍缓存，只是每次用前必须回源校验；`no-store` 才是不存。

### `/schedule/api/ai/chat` 单独一块（SSE）

父块的两个默认值会把流掐死，所以另起一块（紧跟父块）：`proxy_http_version 1.1`、
`proxy_buffering off`、`proxy_read_timeout 300s`、`proxy_set_header Connection ""`、
`add_header Cache-Control "no-store" always`。

| 那一条 | 不写会怎样 |
|---|---|
| `proxy_read_timeout 300s` | **实测**：父块的 30s 会让静默超过 30 秒的那一轮直接 504（造了个静默 35 秒的上游，走父块 30.03s 就 504） |
| `add_header …` | **实测**：不写就没有 `no-store`。`add_header` 只在同层没写过时才继承，这两块是**同层的两个 location**，不是父子 |
| `proxy_buffering off` | 本机上开与关量不出差别，留着是防 payload 变大或链路开 gzip 时咬人 |

### 补斜杠与 Service Worker

**`/schedule` 无尾斜杠必须显式 301**：少了尾斜杠，页面里的相对路径（`./api/…`）会解析到
站点根 → 接口全 404 + 白屏。前端用 `fetch('./api/' + path)` 就是为了前后端同源、
后端一行 CORS 都不用写，**改前端请求路径前先想清楚这条**。

**新版自己注册一个 SW**（`app/public/sw.js`），作用只有一个：断网时还能把应用打开。
预缓存清单是装的时候**现场从 index.html 抠的**（产物文件名带哈希，写死会立刻过期），
验收标准是「打开一趟，`caches.keys()` 里有 `sched-shell-v4`，里面装着 index.html、
它引用的 assets、外加 `manifest.json` / `icon.svg`」。
改了缓存策略要顺手改 `CACHE` 名（现在 `sched-shell-v4`，见 `app/public/sw.js`），否则 `activate` 删旧缓存那步不触发；
只改 `sw.js` 代码不用动版本号。

旧的那个（`schedule-v12`）在 `main.tsx` 的 `migrateAwayFromLegacySW()` 里被拆掉，
用 localStorage 标记锁成一次性，删缓存只认 `/^schedule-v\d+$/`。

### HTTPS

证书在 `conf.d/common/ssl.conf`，宿主机 `certs/live/xiaokubao.space/` 挂成只读，
覆盖 `*.xiaokubao.space` 通配。**续期没有自动化**（没有 certbot 容器，crontab 与
systemd timer 里都没有），换证书就是覆盖四个 pem 然后 `nginx -t && reload`。

---

## 六、发布后验证

```bash
B=https://home.xiaokubao.space/schedule
for p in "/" "/manifest.json" "/icon.svg" "/api/health" "/api/me" \
         "/app/src/main.tsx" "/server/server.js" "/legacy/dist/app.js" "/.git/config"; do
  printf '%-24s %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' $B$p)"
done
```

期望：`/` 200 · `/api/health` 200 · `/api/me` **401**（401 而不是 404 才说明路由在）·
其余源码与内务路径全 404。

```bash
curl -skI $B/index.html | grep -i cache-control            # no-cache
curl -skI $B/api/health | grep -i cache-control            # no-store
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' $B   # 301 -> .../schedule/
```

端到端（改了共享 / 权限 / 同步一定要跑）：

```bash
node server/tests/smoke-share.mjs          # 两人共享一个集（临时后端，不碰线上库）
node app/tests/browser-smoke.mjs           # 注册 → 建任务 → 拖拽 → 同步，真 Chrome
node app/tests/card-geometry.mjs           # 卡片几何 + 手势分工
node app/tests/contrast.mjs && node app/tests/color-scan.mjs
```

> 探针都会自己起一套隔离环境（临时后端 + 静态服务 + 独立 Chrome profile），
> **自动构建 `dist/`**，直接从仓库根跑即可。改完仍建议手工点一遍 ——
> 探针覆盖的是主链路，不是手感。

**清空一个测试账户的数据**（想清库重来，别碰生产 `data/` 目录）：

> ⚠️ 下面这条命令**删的是整个数据目录，连 `secret.key` 一起删** ——
> 结果是**所有账户当场被登出**，而不只是清掉某个人的日程。只在你确实要
> 「从零开始，所有人重新注册」时才用；只是想验证一个空账户，注册个新用户名就行。

```bash
systemctl --user stop schedule-backend     # 先停，WAL 才干净落盘
mv ~/.local/schedule/data ~/.local/schedule/data.$(date +%m%d-%H%M%S)   # 改名而不是删
systemctl --user start schedule-backend    # 起来时自动建空库 + 新 secret.key
```

> 用 `mv` 不用 `rm -rf`：改名是秒级的、可撤销的，真删错了没有任何后悔药
> （`schedule.db` 里是所有人的全部任务）。确认不要了再手动清掉那个 `data.<时间>` 目录。

---

## 七、回滚

| 故障 | 动作 |
|---|---|
| 前端新版有问题 | `./deploy/publish-web.sh --rollback --approve`（拷回最新那份发布备份，秒级，会先把候选列出来）。⚠️ 别 `mv` 目录本身 |
| 后端新版有问题 | `./deploy/publish-server.sh --rollback --approve`，或干脆 `systemctl --user stop schedule-backend`（页面还开得了，离线副本也能看） |
| 想临时下线整站 | `conf.d/home/schedule.conf` → `.conf.disabled`，然后 `nginx -t && reload` |
| APK 坏包 | 改回 `apk/version.json` 的 versionCode，或删掉 version.json |
| nginx 整体起不来 | 恢复 `docker-compose.yml.bak-*` / `schedule.conf.bak-*`，再 `docker compose up -d` |

> 退回旧版（`legacy/`）时：旧版读 localStorage 的 `schedule-app-v1`，新版从不写那个 key
> （只读一次），所以旧数据还在，只是新版期间新增的任务看不到 —— 它们在服务器库里。

---

## 八、排障

| 现象 | 查什么 |
|---|---|
| 改了代码页面没变 | 前端要 `publish-web.sh`；还是旧界面就清 Service Worker |
| 登录不上 / 操作没反应 | `systemctl --user status schedule-backend`；`journalctl --user -u schedule-backend -n 50` |
| 接口全 404 | `/schedule/api/` 那块丢了或没带 `^~`；或后端没起 |
| 页面 404 | `servers/home.conf` 里忘了 `include schedule.conf` |
| 页面能开但资源全 404 | 访问的是 `/schedule`（无尾斜杠）；或 `vite.config.ts` 的 `base: './'` 被改了 |
| 两台设备数据不一致 | 顶栏同步图标还在转？转 → 还在推。逐字段 LWW，同一字段才是「后改的赢」 |
| 数据不对 / 像丢了几条 | **先看服务器库**，浏览器那份只是副本 |
| 所有人都掉登录了 | `secret.key` 被换 / 删了，重新登录即可，数据不受影响 |
| 后端起不来 EADDRINUSE | 有个手动起的 node 还占着 25692：`ss -lptn 'sport = :25692'` |
| 手机装成 App 后霸占整站 | PWA `scope`（`manifest.json` 里是 `./`，已锁在 `/schedule/`） |

### 环境踩坑

**只在部署时撞上的**：

1. **`scp` 传中文路径报 `pipe: Unknown error`**：改用 `cat 文件 | ssh ubuntu "cat > 目标"`。
2. **SSH 别名是 `ubuntu`**（`~/.ssh/config`），不是 `nas`。⚠️ **别把「本机」当服务器**：
   · **NAS 本机**（`xiaokubao-fn`，`192.168.1.4`，工程目录 `/vol2/…` 是本地 btrfs）：
     **没有** nginx 容器、没有 `~/docker`、也没有 `~/.local/schedule/data`。
   · **服务器 ubuntu**（`192.168.1.6`）：nginx / 后端 / 生产目录都在这儿，工程目录是
     autofs 挂上来的 CIFS（`/mnt/fnos/…`）。
   所以「改配置直接 cp」说的是**在 ubuntu 的 shell 里**；从 NAS 上改要先 ssh 过去。
3. **无头 Chrome 最小窗口宽度约 526px**：`--window-size=390` 实测 `innerWidth` 是 526。
   要真窄屏走 `Emulation.setDeviceMetricsOverride`（媒体查询真的生效，见
   [踩坑-环境.md 第 24 条](docs/踩坑-环境.md)）。

其余与环境有关的（`systemctl --user` 总线 / SMB 丢文件 / `pkill -f` 打到自己）见
[踩坑-环境.md](docs/踩坑-环境.md) 第 21–23 条，这里不重复。

---

## 九、相关文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 结构、不变量、界面硬规则、给 AI 的硬约束 |
| [README.md](README.md) | 怎么用、日常命令 |
| [docs/架构决策.md](docs/架构决策.md) | 为什么是现在这样（同步 / 多账户 / 小组件 / 不做的事） |
| [docs/接口.md](docs/接口.md) | HTTP 接口总览（+ `-日程集` / `-同步` / `-AI`） |
| `deploy/schedule.conf` | nginx 配置的本地副本 |
| `deploy/schedule-backend.service` | 后端 systemd 单元的本地副本 |
| `deploy/nginx-compose.yml` | nginx compose 的副本（服务器上还有一份） |
| `/home/xiaokubao/docker/nginx/conf.d/README-hosts.md` | 全站域名 ↔ 设备 ↔ 路径映射表 |
