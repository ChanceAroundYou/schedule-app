# 日程清单 · 部署与运维

一台 Ubuntu（`192.168.1.6`，SSH 别名 `ubuntu`）：nginx 容器伺服前端并反代 `/schedule/api/`，后端是宿主机上的 systemd user 服务（Node 22，只听 127.0.0.1:25692）。

> 本文所有 `~/` 都是服务器 ubuntu 上的家目录，不是 NAS 本机。工程目录只是源码，线上不读它。

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `deploy/env.sh` | **构建环境统一入口**：读 `.env` + 按平台探测 JDK / SDK / Gradle / aapt（被下面几个脚本 source） |
| `deploy/web-loop.sh` | 网页端一键闭环：可追溯 → tsc → 单测 → 本地深测 → 发布 → 线上实测 |
| `deploy/mobile-loop.sh` | 手机端：+版本号自检 → 打包 → 发布 → 装机 → 真机冒烟 |
| `deploy/publish-web.sh` | 前端发布（构建 → 上传 → 备份 → 切换 → 回读） |
| `deploy/publish-server.sh` | 后端发布（拷代码 → 备份 → restart → 探活） |
| `deploy/gradle.sh [任务]` | **Android 编译唯一入口**：自动摆正 gradle / SDK / JDK，默认 `:app:assembleDebug` |
| `deploy/publish-apk.sh "说明"` | 原生层（小组件/权限/图标）必须换 APK 才生效 |
| `deploy/install-deps.sh` | 首次安装 / 换机器装 AI 依赖 |

参数（所有 publish 脚本通用）：`--approve` 真发布 · `--force` 强制重发 · `--rollback` 回滚（也要 `--approve`）· `--skip-build` 仅 web 用现有 dist · `--allow-dirty` / `--allow-unpushed` 逃生口。

## 构建环境（每台设备一份 .env）

APK 构建要 JDK 21 + Android SDK（`platforms;android-36`、`build-tools;36.0.0`）+ Gradle
8.14.3。路径**不再写死在脚本里**，统一由 `deploy/env.sh` 处理：

1. 读项目根的 `.env`（本机私有，已 gitignore）；
2. 没写的变量按平台探测（Windows 的 `C:/Program Files/Microsoft/jdk-21…`、
   Linux 的 `/vol2/.toolchains/…` 与 `~/.local/toolchains/…`、`/usr/lib/jvm/…`）；
3. 仍找不到就报错并提示改 `.env`，不会再让 gradle 抛半截错误。

首次在新设备上构建：

```bash
cp .env.template .env      # 按本机路径改
# 变量：JAVA_HOME / ANDROID_HOME / GRADLE / SSH_HOST / BASE_URL / API_BASE
# 密码不进 .env —— keystore 密码只在 app/android/keystore.properties（已 gitignore）
```

本机（fn / NAS Linux）的持久工具链放在 `/vol2/.toolchains/`：

```text
/vol2/.toolchains/jdk-21                 JDK 21.0.13
/vol2/.toolchains/android-sdk            SDK（platform-tools / android-36 / build-tools 36.0.0）
/vol2/.toolchains/gradle-8.14.3          Gradle 8.14.3
```

Windows 笔记本继续用它自己的 `C:/Users/小哭包/...` 路径（写进各自的 `.env` 即可）。
两边跑的是**同一套** `deploy/*.sh`，不再有分叉版本。

签名：`app/android/keystore.properties` 与 `~/.android/schedule-release.jks` 必须成对
存在（Linux 侧 `storeFile` 写 `/home/xiaokubao/.android/schedule-release.jks`，
Windows 侧写 `C:/Users/小哭包/.android/schedule-release.jks`）。

## 发布流程

```bash
# 1. 提交 + 推送
git add <本任务文件> && git commit && git push

# 2. 体检（必须为空）
git status --porcelain
git stash list
git ls-files -u
git log @{u}.. --oneline

# 3. dry-run
./deploy/publish-web.sh
./deploy/publish-server.sh

# 4. 授权
./deploy/publish-web.sh --approve
./deploy/publish-server.sh --approve
```

日常直接用 `./deploy/web-loop.sh` / `./deploy/mobile-loop.sh`。

## Android 编译工具链（别手动敲 gradle）

**一律用 `./deploy/gradle.sh <任务>`**，不要 `./gradlew`，也不要裸 `gradle`。
2026-10-25 手动敲 `./gradlew` 卡了 40 分钟，原因是三条互不相干的坑：

| 坑 | 症状 | 真相 |
|---|---|---|
| `./gradlew` 先下发行版 | 没有任何输出，看起来卡死，能卡半小时 | wrapper 在下 `gradle-8.14.3-all.zip`（230MB）；本机 `~/gradle-dist/gradle-8.14.3/` 已有解压好的，脚本优先用它 |
| 没设 `ANDROID_HOME` | `SDK location not found` | `app/android/local.properties` 是**空文件**，指望不上；SDK 在 `~/Android` |
| 没锁 `JAVA_HOME` | 前面都过，`compileDebugJavaWithJavac` 才炸 | 系统里可能有多套 JDK，要 jdk-21 |

`gradle.sh` 三件事全做（探测顺序：显式环境变量 → 常见路径 → 报错并给提示），
`build-apk.sh` / `publish-apk.sh` 都已改成调它，换机器不再需要改脚本里的绝对路径。

**⚠️ 两套入口别互相覆盖**（2026-10-26 实测踩的，`52131ad` 已修）：`env.sh` 会
`export GRADLE`，而 `gradle.sh` 的逻辑是「`${GRADLE:-}` 非空就直接用」——
于是 `env.sh` 里默认指向仓库 wrapper 的那一版会**盖掉** `gradle.sh` 的
「优先用 `~/gradle-dist`」探测，构建照样去下 230MB，代理环境下 `read timeout`，
表现为**打包卡 20 分钟、零产物、最后报 Downloading failed**。
→ 两边的探测顺序必须一致（显式 `$GRADLE` → `~/gradle-dist/gradle-*/bin/gradle`
里版本最大的 → wrapper 兜底）。改其中任何一个，另一个也要同步。
排查线索：`gradle.sh` 第一行会打印 `==> gradle <路径>`，看到 `app/android/gradlew`
就是退回 wrapper 了。

## 发布约束（不能破）

1. 只换目录内容，**绝不 `mv` 目录本身**（Docker bind mount 认 inode）。
2. 指纹命令里 `sed 's/\*//g' | tr -s ' '` 别删。
3. `app/node_modules` 软链只在 `[ ! -e node_modules ]` 时补。
4. 打包强制 `--mode='u+rwX,go+rX'`，解包后 chmod 并数文件数。
   **两条发布路径都要**（web 2026-10-24 补的，server 到 2026-10-28 才补上 —— 漏着的那条
   不是发布时出事，是 dry-run 就死在「1/7 打包内容」：CIFS 上的目录出来是 `075`，
   属主读不动，解到 `/tmp` 之后连 `ls` 都失败）。归模式只写进归档头，**不去 chmod
   CIFS 上的源码目录** —— 那是另一台设备也在用的共享工作区。
5. 回读校验以服务器磁盘那份 `index.html` 为准。
6. **打包前先在本地盘暂存一份产物**（`/tmp/schedule-web-stage` / `/tmp/schedule-server-stage`），
   tar 只读那一份。`dist/` 在 CIFS 上，刚 `npm run build` 写完的大文件还压在写回缓存里，
   直接在工程目录里 tar 会报 `file changed as we read it`（tar 退出码 1，`pipefail`
   让整条管道死在上传这一步：生产没动，远端 `web.new` 留了一份半成品）—— 2026-10-28 实测。
7. **ssh 那个双引号串内不许出现反引号**：本地 shell 会把它当命令替换执行。
   2026-10-25 在 publish-web.sh 炸过一次（把远端脚本改坏），2026-10-28 在 publish-server.sh
   的注释里又冒出一条 `-rollback-: command not found`（这次只少了一行注释）。
   检查方法：把四个发布脚本逐行扫一遍「处在双引号串内的反引号」，应为零。

回滚：`./deploy/publish-web.sh --rollback --approve`（或 server），或停后端服务。

## 验证

```bash
B=https://home.xiaokubao.space/schedule
for p in "/" "/manifest.json" "/icon.svg" "/api/health" "/api/me" \
         "/app/src/main.tsx" "/server/server.js" "/.git/config"; do
  printf '%-24s %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' $B$p)"
done
curl -skI $B/index.html | grep -i cache-control   # no-cache
curl -skI $B/api/health | grep -i cache-control    # no-store
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' $B  # 301
```

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
| 桌面看不到「计数器」小组件 | ① 关于页 versionCode 是否 ≥61（没到就先更新 App）；② 重启启动器/整机；③ `adb shell dumpsys appwidget` 看 CounterWidgetProvider 是否注册 |
| 构建报 `invalid source release: 21` | `.env` 的 `JAVA_HOME` 指到了 JDK 17；换成 21 |
| 构建报找不到 `cordova.variables.gradle` | 先 `cd app && npx cap sync android` |
| 构建报 `SDK location not found` | `.env` 的 `ANDROID_HOME` 没设或目录里没有 `platforms/` |
| 后端起不来 EADDRINUSE | `ss -lptn 'sport = :25692'` |

环境细节见 [docs/踩坑-环境.md](docs/踩坑-环境.md)。

## 相关文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 结构、不变量、工作约束 |
| [docs/架构决策.md](docs/架构决策.md) | 为什么是现在这样 |
| `deploy/schedule.conf` | nginx 配置本地副本 |
| `deploy/schedule-backend.service` | systemd 单元本地副本 |
