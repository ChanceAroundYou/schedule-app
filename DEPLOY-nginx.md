# 部署 · nginx 怎么操作

> **五份运维文档**：拓扑与上线 → [DEPLOY.md](DEPLOY.md)；nginx 怎么操作 →
> [DEPLOY-nginx.md](DEPLOY-nginx.md)；conf 怎么写 → [DEPLOY-conf.md](DEPLOY-conf.md)；
> 发布 / 回滚 / 结构适配 → [DEPLOY-运维.md](DEPLOY-运维.md)；环境踩坑与故障排查 →
> [DEPLOY-排障.md](DEPLOY-排障.md)。**章节号沿用原来的，交叉引用不用改。**


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

---
