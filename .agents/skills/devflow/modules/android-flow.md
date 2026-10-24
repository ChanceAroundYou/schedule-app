# 分支 B · Android App 端

**何时读**：改动落在 `app/android/`、`versionCode`、原生插件、小组件，或用户说「打 APK / 装手机 / 发移动端」。

> 前置阅读：`mobile/device-setup.md`（连设备）、`mobile/adb.md`（安装与校验）、
> `mobile/mobile-test.md`（真机断言）、`mobile/troubleshooting.md`（出问题怎么查）。

## 一条命令跑完七段（对标网页端 web-loop.sh）

```bash
./deploy/mobile-loop.sh                                  # 全套七段
./deploy/mobile-loop.sh --device 192.168.1.172:38237     # 顺带指定设备（端口会轮换，见 device-setup）
./deploy/mobile-loop.sh --no-publish                      # 只装机本地包，不发到线上
./deploy/mobile-loop.sh --no-build                        # 已打过包，跳过打包/发布
./deploy/mobile-loop.sh --debug                           # 装 debug 包（要 CDP 跑 android-live-check 时；同签名不丢数据）
./deploy/mobile-loop.sh --probe                           # 额外跑坐标时序回归（kbtiming.cjs）
./deploy/mobile-loop.sh --install-only                   # 已发过版，只装 + 冒烟
```

| 段 | 内容 | 失败时 |
|---|---|---|
| 1 可追溯性 | 发布路径（`app/src`、`app/index.html`、`app/tests`、`server/`、`package*.json`、`app/package*.json`、`app/android/app/src/`、`app/android/app/build.gradle`）有未提交改动就拒发 | 先 commit |
| 2 类型检查 | `tsc --noEmit`（网页端与安卓端共用同一套 TS 源码） | 修类型 |
| 3 单测 | app（`src/**/*.test.ts`）+ server（`server/tests/*.test.js`） | 修逻辑/补断言 |
| 4 版本号自检 | `versionCode` 必须比线上大；`versionName` 与 `app/package.json` 同源 | 升 build.gradle 的 `versionCode` / 对齐 `versionName` |
| 5 打包 | `build-apk.sh`（注入 `VITE_API_BASE` + `cap copy` + gradle） | 修构建 |
| 6 发布 + 装机 + 版本校验 | `publish-apk.sh` → 下载 → `adb install -r` → `dumpsys` 回读 `versionCode`/`pkgFlags` | 见下 |
| 7 真机冒烟 | 冷启动 → 崩溃栈检查 → 截屏（可选 `--probe` 跑 kbtiming 时序回归） | 见下 |

任一段失败 → 退出码非 0，由 devflow 自动返工（修 → 重新 commit → 重跑），最多 3 轮；
3 轮还不过就停下，用大白话告诉用户卡在哪、具体报什么。

## 真机实测（android-live-check.mjs）检查什么

网页端用 `live-check.mjs` 打生产 URL；安卓端用 **`android-live-check.mjs`** 通过 CDP
驱动真机 WebView（自建极简 WebSocket 客户端，复用 `deploy/cdp.mjs` 同款协议），断言同一套
`core / now-line / repeat`：

- `core`：进应用外壳（日视图时间轴出现）→ 周/月视图渲染 → 零控制台报错（已排除 safe-area 插件噪声）
- `now-line`：今天日视图的当前时间线是 `--ok` 深绿细线、无圆点无时刻文字
- `repeat`：API 建「每周五、六」系列 → 断言周五+周六实例都落到月视图 → `repeatUntil` 收尾
- 机器人账号 `e2e-bot / e2e-bot-2026`（生产库里这一个测试账号，自动登录）
- **必须装 debug 包**（正式包关了 WebView 调试，`webview_devtools_remote_*` 不存在，CDP 连不上；
  debug 与 release 同签名，覆盖安装不丢数据）

跑法（先装 debug 包再跑；脚本会自己冷启动 App 并拉到前台）：

```bash
MSYS_NO_PATHCONV=1 "$ADB" install -r app/android/app/build/outputs/apk/debug/app-debug.apk
node app/tests/android-live-check.mjs --device 192.168.1.172:38237
# 只跑部分：--features core,now-line   /   --features repeat
```

> ⚠️ CDP 在 OPPO/ColorOS 上「一个会话结束后再 attach 会无响应」—— 所有用例写进
> 这一个脚本一次跑完（脚本内部多步操作是稳的）。不要在中间重启 App。
> 键盘/输入法相关（输入法弹起、收起后布局）只能真手指验收，脚本测不了，见下「自动化边界」。

## 版本号（5 文件 8 行，改一个必须改另一个）  [B1]

| 文件 | 改什么 |
|---|---|
| `package.json` | `"version": "x.y.z"` |
| `app/package.json` | 同上（网页「设置 → 关于」显示的版本） |
| `package-lock.json` | 第 3 行 + 第 9 行（根包 + workspace 条目） |
| `app/package-lock.json` | 同上（**别改到依赖自己的版本号**，如 `native-run 2.0.3`） |
| `app/android/app/build.gradle` | `versionName "x.y.z"`（同号）+ **`versionCode` 严格递增** |

改完 lock：`cd app && npm install --package-lock-only && cd .. && npm install --package-lock-only`

⚠️ **`versionCode` 忘了加，客户端永远收不到更新提示**（服务端 version.json 里的
versionCode 不大于本机就不会提示）。

## 打包（build-apk.sh）  [B2]

它做三件容易漏的事，**漏了都不报错、只会悄悄不对**：
1. `VITE_API_BASE` 注入（不注入 → App 连不上后端，界面看着像「数据有点旧」）
2. `cap copy android`（不做 → APK 里是旧前端资源，改了代码但手机上没变化）
3. `vite build` + gradle

## 发布（publish-apk.sh "说明"）  [B3]

- `assembleRelease`（固定 keystore 签名，**签名不可换**，换了只能卸载重装）
- 从产物读 `versionCode`/`versionName`（不信 `build.gradle`，信 APK 本身）
- 上传 `schedule-<versionCode>.apk` + `version.json`，回读校验 200
- 自动写 `~/.local/schedule/state/app.version`；服务器留最近三份可回滚

⚠️ **顺序铁律：先网页端再 APK**。`publish-web.sh` 重建的是无基址 dist，
`build-apk.sh` 重建的是有基址 dist，两边交替覆盖。
正确顺序：`publish-web` → `build-apk` → `publish-apk`。
若已经发过网页端才想起来打 APK，重跑一次 `build-apk.sh` 再发。

## 装机（真机）  [B4]

```bash
# 装线上正式包（推荐给用户的版本）
curl -sS -o /tmp/s.apk "https://home.xiaokubao.space/schedule/dl/schedule-<code>.apk"
MSYS_NO_PATHCONV=1 "$ADB" install -r "C:/Users/小哭包/AppData/Local/Temp/s.apk"

# 或装同签名的 debug 包（要 CDP 调试时用这个，数据不丢）
MSYS_NO_PATHCONV=1 "$ADB" install -r "C:/Users/小哭包/coding/schedule-wt/app/android/app/build/outputs/apk/debug/app-debug.apk"
```

必校验：`versionCode` / `versionName` 与发布一致；`pkgFlags` 无 `DEBUGGABLE`（正式包）。

## 真机验证清单  [B5]

按 `mobile-test.md` 的「断言清单模板」逐项过；自动化边界内的项目（键盘/输入法）
明确转给用户真手指验收，并说清要观察什么。

## 汇报  [B6]

给：versionCode / versionName、APK sha256 前缀、真机确认到的版本、冷启动是否正常、
哪些项自动化验过、哪些项需要用户真手指确认。

## 更新提示本身出问题时的排查

用户说「点了更新，授权回来按钮消失了、再也不提示」→ 是「先标记已提示、后检查授权」
的顺序问题（本项目 `AppUpdate.java` 已修：标记后移 + 授权回来自动补刀 + 关于页有
「检查更新」按钮）。再遇到就往这个方向查。

## 没人会踩的坑（记下来省时间）

- **App 没有 `[data-nav="calendar"]`**：网页端登录后落在「今天」列表页，要先点这个
  导航才进视图；App 直接进某个视图（默认日/周由 `ui.view` 决定），切换视图用
  `button[data-view="day|week|month"]`。别拿网页端的选择器硬套。
- **顺序铁律：先网页端再 APK**（见 B3）。
- 发布脚本默认 dry-run（不带 `--approve` 只打印摘要、退出码 1）；`mobile-loop.sh`
  是替用户判断过的自动放行，它自己做了可追溯性检查。
- `--allow-dirty` 只在「脏文件全在发布路径之外」时用（例如 `deploy/` 下的草稿脚本）。
- 键盘相关：别用 `visualViewport` 差值判键盘高度（App 是 adjustResize，相减恒为 0）；
  用 `@capacitor/keyboard` 原生事件。**坐标与 rect 必须同一时刻取**（pointerdown 快照），
  否则 21:00 会算成 7:00。
- 别反复 `adb connect`：每连一次手机弹一次系统通知，用户被烦过。一条命令里
  `start-server` + `connect` 一次即可。
- 改过的系统设置（`svc power stayon`、输入法开关）用完还原。
- **用户报告的现象先当真 bug**：2026-10-17 在「输入法闪一下」上误判过两次，
  以为测试工具假象，结果真手指一样复现。别先归咎工具局限。
- **真机实测前先 `am start -n` 把 App 拉到前台**：`monkey` 启动常把 App 留在后台，
  WebView 不建调试通道，`webview_devtools_remote_*` 就为空，CDP 连不上。

## 自动化边界（键盘/输入法必须真手指验收）

| 现象 | 为什么测不了 | 怎么办 |
|---|---|---|
| 输入法弹起 / 收起 | Android 只允许真实用户手势唤出键盘，adb 和 CDP 注入都不行 | 请用户真手指点，并明确告诉他要观察什么 |
| 键盘弹出后的布局 | 同上 | 同上 |
| 系统权限弹窗 / 指纹 / 人脸 | 系统级 | 同上 |

## 数据卫生

用 CDP/API 建过的测试任务（「e2e安卓重复-xxx」这类）**收尾必须删/结束**：
`repeat` 检查里已用 `repeatUntil=今天` 结束系列，实例由级联清掉。
残留了就手动在 App 里删：逾期/今天列表 → 多选 → 勾选 → 删除 → 确认。
