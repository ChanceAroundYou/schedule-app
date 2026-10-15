# 部署 · 环境踩坑与故障排查

> **五份运维文档**：拓扑与上线 → [DEPLOY.md](DEPLOY.md)；nginx 怎么操作 →
> [DEPLOY-nginx.md](DEPLOY-nginx.md)；conf 怎么写 → [DEPLOY-conf.md](DEPLOY-conf.md)；
> 发布 / 回滚 / 结构适配 → [DEPLOY-运维.md](DEPLOY-运维.md)；环境踩坑与故障排查 →
> [DEPLOY-排障.md](DEPLOY-排障.md)。**章节号沿用原来的，交叉引用不用改。**


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

**新版没有窄屏 / 触屏的自动化覆盖** —— ≤900px 的标签栏、长按操作层只能手工在
真机上看。（原先 `app/tests/smoke.mjs` 只跑一个 1440×900 的桌面视口，
2026-10-15 已连同 `browser-smoke.mjs` 一起删掉。）
其余测试坑见 [docs/踩坑.md](docs/踩坑.md) 第 33 条。

---

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

---

## 十、相关文档

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **往哪走**：结构、数据模型不变量、界面硬规则、最容易翻车的十条 |
| [docs/踩坑.md](docs/踩坑.md) | **改代码前先读**：40 条坑 |
| [docs/测试.md](docs/测试.md) | 怎么验：跑哪些测试 |
| [README.md](README.md) | 怎么用、数据在哪、日常命令 |
| [docs/接口.md](docs/接口.md) | HTTP 接口总览 + 认证（+ `-日程集` / `-同步` / `-AI`） |
| [docs/重构路线.md](docs/重构路线.md) | 这次前后端分离重写的决策记录 |
| `deploy/schedule.conf` | nginx 配置的本地副本（服务器上还有一份） |
| `deploy/schedule-backend.service` | 后端 systemd user 单元的本地副本 |
| `/home/xiaokubao/docker/nginx/conf.d/README-hosts.md` | 全站域名 ↔ 设备 ↔ 路径的映射表 |
| `/home/xiaokubao/docker/nginx/conf.d/home/balanceapi.conf` | 账本的 conf，写 location 时可对照 |
