# 日程清单 —— 部署与运维

nginx 怎么操作、conf 怎么写、改完代码怎么上线、出问题怎么退。
命令都是在这台机器（Ubuntu，`192.168.1.6`）上实测过的，路径照抄即可。

面向人：部署、排查线上问题、迁移到新机器。
面向 AI：改路由、改缓存策略前先读「五、与现行结构的适配」——那几条每条都是踩坑换来的。

> **2026-10-06 起本项目前后端分离了。** 前端 React 构建产物 + 一个自写的
> Node 后端（SQLite），数据在服务器上。**旧版那份「纯静态、数据只在浏览器里」
> 的说明已经作废**，但旧版整个留档在 `legacy/`，随时可以退回去。

---

> **五份运维文档**：拓扑与上线 → [DEPLOY.md](DEPLOY.md)；nginx 怎么操作 →
> [DEPLOY-nginx.md](DEPLOY-nginx.md)；conf 怎么写 → [DEPLOY-conf.md](DEPLOY-conf.md)；
> 发布 / 回滚 / 结构适配 → [DEPLOY-运维.md](DEPLOY-运维.md)；环境踩坑与故障排查 →
> [DEPLOY-排障.md](DEPLOY-排障.md)。**章节号沿用原来的，交叉引用不用改。**


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
│   /schedule/      → /data/schedule-web/    静态 alias，只读挂载 │
│   /schedule/dl/   → /data/schedule-apk/    App 自更新的安装包   │
│   /schedule/api/  → 127.0.0.1:25692        反代到后端          │
└──────────────────────────────────────────────────────────────┘
        ▲                       ▲                    ▲
        │ /data/schedule-web    │ /data/schedule-apk │ 127.0.0.1:25692
        │ （本机磁盘，只读）      │ （本机磁盘，非 NAS） │
   ~/.local/share/schedule-web  ~/.local/share/schedule-apk
   ⚠️ 工程目录**不再挂进容器**    schedule-backend.service
   （2026-10-15 改，见 1.4）      （跑 ~/.local/share/schedule-app）
                                               │
                                               ▼
                        /home/xiaokubao/.local/share/schedule/schedule.db
                        ⚠️ 本机磁盘，不在 NAS 上（原因见 1.2）
```

### 1.1 两个进程，各自独立

| | 前端 | 后端 |
|---|---|---|
| 是什么 | Vite 构建产物 | Node 22 + node:sqlite，**只引 AI 那一组依赖**（见 1.3） |
| 谁在伺服 | nginx（容器） | systemd user 服务 |
| 端口 | 无（nginx 直读文件） | 127.0.0.1:25692 |
| 改完怎么生效 | **`./deploy/publish-web.sh`**（构建 → 上传 → 备份 → 切换 → 回读校验） | **`./deploy/publish-server.sh`**（拷代码 → 备份 → restart → 探活） |
| 挂了会怎样 | 白屏 | 页面能开，接口全 404，登录不上 |

> ⚠️ **`npm run build` 不等于上线**。工程里的 `dist/` 只是本地产物
> （`browser-cards.mjs` 那种探针要用），线上读的是
> `~/.local/share/schedule-web/`，发布必须显式跑 `publish-web.sh`。
> 2026-10-15 之前 nginx 直接读 SMB 工程目录里的 `dist/`，构建即部署 —— 已改掉，见 1.4。

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
| `/mnt/fnos/family/星星包/coding/日程管理` | 全部源码（本项目仓库）。**2026-10-15 起线上不再读它** —— 它是 SMB 上的活工作区，只是源码 |
| `/home/xiaokubao/.local/share/schedule-web` | **前端线上产物** = `dist/` 的拷贝，nginx alias 到它。发布见 `deploy/publish-web.sh` |
| `/home/xiaokubao/.local/share/schedule-app` | **后端线上代码** = `server/` 的拷贝 + `node_modules` 软链。systemd 的 WorkingDirectory。发布见 `deploy/publish-server.sh` |
| `/home/xiaokubao/.local/share/schedule` | **运行时数据：SQLite 库 + 密钥** |
| `/home/xiaokubao/.local/share/schedule-deps` | **后端依赖（112 MB）**，见 1.3 |
| `/home/xiaokubao/.local/share/schedule-apk` | **App 自更新的安装包**（`schedule-<versionCode>.apk` + `version.json`），nginx 挂在 `/schedule/dl/`。同样不放工程目录 —— SMB 读大文件不可靠。发布见 `deploy/publish-apk.sh` |
| `/home/xiaokubao/docker/nginx` | nginx 的 compose + `conf.d/` + `certs/` |

> `/home/xiaokubao/family` 是指向 `/mnt/fnos/family` 的软链，同一份文件，
> 两个路径都能开。compose 与 systemd 单元里用的都是软链那条。

### 1.3 后端依赖装在本机磁盘（2026-10-06 起）

**后端不再是零依赖了。** AI 那一组（`@earendil-works/pi-agent-core` +
`@earendil-works/pi-ai`）是唯一允许的例外 —— 用户明确推翻了原来的「零依赖」约束，
理由是与其手搓 agent 的工具循环，不如接生态里现成的框架。完整的边界写在
`CLAUDE.md` 五、1：**只许引 AI 这一组，加别的仍然要先问。**

依赖**不落在工程目录里**，因为那是 CIFS/SMB（理由同 1.2：NAS 上成千上万个小文件
正是丢文件的高风险场景）。装到本机磁盘，工程根目录放一个软链接指过去：

```bash
# 首次安装（或换机器）
mkdir -p ~/.local/share/schedule-deps
npm install --prefix ~/.local/share/schedule-deps \
    @earendil-works/pi-agent-core@1.0.4 @earendil-works/pi-ai@1.0.4
ln -s ~/.local/share/schedule-deps/node_modules <工程根>/node_modules

# 核对：应当打印出 pi-ai 子路径 ✓
#（别去 resolve package.json —— pi-ai 的 exports 没导出它，会报
#  ERR_PACKAGE_PATH_NOT_EXPORTED，那个报错不代表依赖没装好）
node --input-type=module -e "import('@earendil-works/pi-ai/api/openai-completions').then(() => console.log('pi-ai 子路径 ✓'))"
```

> **要重启后端**才会用上新装的依赖：`systemctl --user restart schedule-backend`。

> **`node_modules` 在 `.gitignore` 里，软链不进版本库** ——
> 每份新 checkout（包括 `.worktree/` 下的）都要自己补一次这个链接。
> 没补的话服务**照样起得来**（`lib/ai/index.js` 是惰性 import），
> 只是 AI 页会报「依赖没装好」；
> 而**确认提案那条路不受影响** —— `lib/ai/confirm.js` 是 CJS 直接 require、
> 一条都不碰 pi（见 `CLAUDE.md` 二、AI）。

> 为什么是软链而不是 `NODE_PATH`：两者都能让 `require` 找到依赖，软链的好处是
> 不用改 systemd 单元、也不挑进程从哪个目录起。

| 依赖锁 | 值 | 为什么 |
|---|---|---|
| 版本写法 | 精确版本（`1.0.4`），**不用 `^`** | 两个包都还没到 1.x 的稳定期，API 会动 |
| 调用点 | 只在 `server/lib/ai/chat.mjs` | 升版时只改这一个文件 |

### 1.4 线上产物不放工程目录（2026-10-15 改）

**以前**：nginx 把整个 SMB 工程目录挂成 `/data/schedule`，alias 指向它的
`dist/`。于是「本地 `npm run build` 覆盖 SMB 那份 `dist/`」**就等于上线** ——
构建产物落在多设备共享的源码目录里，没有发布动作、没有备份、没有回滚，
而且那份目录你在别的设备上也一直在动（fn-sync 在跑、SMB 丢过文件）。
后端更直接：systemd 的 `WorkingDirectory` 就指着工程目录，别人改一下线上就跟着变。

**现在**：前端产物（`schedule-web`）与后端代码（`schedule-app`）都放本机磁盘
`~/.local/share/` 下，跟 `schedule-apk` / `schedule-deps` 同级；
**工程目录不再挂进 nginx 容器**。发布是显式动作，走 `deploy/publish-*.sh`。

```bash
./deploy/publish-web.sh      # 前端：构建 → 上传 → 备份 → 切换 → 回读校验
./deploy/publish-server.sh   # 后端：拷代码 → 备份 → restart → 探活
# 两者都支持 --rollback，从同层的 .bak-* 拷回去（本机磁盘，秒级）
```

⚠️ **发布只换目录里的东西，绝不 `mv` 目录本身。** Docker 的 bind mount
认的是 **inode**：目录被 mv 走、新目录 mv 上来之后，容器里那个挂载点还指着
旧 inode（已经被删了），nginx 立刻 403
`directory index of "/data/schedule-web/" is forbidden`，**重启容器前不会自愈**
（2026-10-15 实测踩过一次）。所以两个脚本都是「传到临时目录 → 清空目标内容
→ 拷进去」，目标目录的 inode 从建好那天起就不变。

⚠️ `schedule-app/node_modules` **必须**是软链到 `../schedule-deps/node_modules`：
Node 从 `server/` 往上找依赖靠它，缺了服务崩在
`require('@earendil-works/pi-ai')`，而 systemd 会不停重启 —— 看起来像「后端抽风」。
`publish-server.sh` 每次都会重建这条软链。

---

---

## 二、改完代码怎么上线

### 2.1 只改前端

```bash
cd app && npm run build     # 只是产出本地 dist/，**不等于上线**
./deploy/publish-web.sh     # 构建 → 上传 → 备份 → 切换 → 回读校验
```

脚本会：留一份 `schedule-web.bak-<版本>-<时间>`（保留最近 3 份）、比对线上
`index.html` 引用的资源哈希与本地是否一致、逐个 curl 资源确认 200。
**回滚：`./deploy/publish-web.sh --rollback`**（从备份拷回去，本机磁盘，秒级）。

> 刷新生效靠缓存头：`index.html` 是 `no-cache`，`assets/` 带内容哈希长缓存
> （见 `deploy/schedule.conf`）。

### 2.2 改了后端

```bash
node server/tests/api.test.js          # 先跑测试
node server/tests/migration.test.js    # 动过 db.js 就一定跑这个
./deploy/publish-server.sh             # 拷代码 → 备份 → restart → 探活
```

脚本会重建 `schedule-app/node_modules` 那条软链、**restart 后探 `/api/health`**
（探不到就报错退出）、并把最近 6 行日志打给你。
**回滚：`./deploy/publish-server.sh --rollback`。**

> **依赖变了要另外做**（新增/升级 `package.json` 里那组），见 1.3 ——
> 装完不用重装服务，`restart` 一次就够。

> ⚠️ **库结构升版时先备份。** `server/lib/db.js` 的 `user_version` 对不上时：
> 空库 → 推倒重建；**有账户的库 → 逐版执行 `MIGRATIONS`**（只 CREATE / ALTER，
> 绝不 DROP、绝不改已有数据）。所以从旧版升上来的第一次启动会**自动改库**：
>
> ```bash
> systemctl --user stop schedule-backend
> cp -a ~/.local/share/schedule ~/schedule-backup-$(date +%Y%m%d)   # 见 1.2
> systemctl --user start schedule-backend
> journalctl --user -u schedule-backend -n 30     # 迁移失败会 throw，服务起不来
> ```
>
> `user_version` 对不上**又没有对应迁移**时会直接 `throw` 拒绝启动（保留的这层
> 保护是刻意的）。真遇上就先别动，别去手改库里的版本号。
> 迁移测试在 `server/tests/migration.test.js` —— 那是全项目唯一「跑错会吃掉
> 用户数据」的代码，值得比别的测试更啰嗦。

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
