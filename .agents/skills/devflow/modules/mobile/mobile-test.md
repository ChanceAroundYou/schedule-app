# 移动端测试与回归

**何时读**：要在真机上验证任何改动之前。

## 一、与网页端的对照基线（先看清缺什么）

| 段 | 网页端（基线，已有） | 移动端 | 状态 |
|---|---|---|---|
| 1 可追溯性 | 发布路径无未提交改动 | 同左（版本号 5 文件 8 行要一起改） | ✅ 有，但版本散在 5 个文件 |
| 2 类型检查 | `tsc --noEmit` | 同左（共用） | ✅ |
| 3 单测 | app 179 + server 83 | 同左（共用） | ✅ |
| 4 本地深测 | `browser-smoke.mjs`（436 断言） | **无** | ❌ 缺失最大 |
| 5 一键脚本 | `web-loop.sh`（五段串起来 + 失败返工） | `mobile-loop.sh`（七段，2026-10-17 补上） | ✅ 已补齐 |
| 6 发布后实测 | `live-check.mjs` 打生产 URL | `android-live-check.mjs` 通过 CDP 打真机断言（core/now-line/repeat） | ✅ 已固化（2026-10-18 补上并真机验证 16/16 通过） |
| 7 设备准备 | 不需要 | 配对/连接/授权/防掉线 | ❌ 之前完全没写 |
| 8 日志采集 | 控制台报错 | `logcat` | ❌ 之前没写 |
| 9 截图采集 | Playwright 截图 | `screencap` + 像素分析 | ❌ 之前没写 |
| 10 故障排查 | 有（看线上断言失败点） | **无** | ❌ 之前没写 |
| 11 数据卫生 | e2e-bot 专用账号 | CDP 建的垃圾任务要删 | ⚠️ 靠人记 |
| 12 自动化边界 | 无（都能自动化） | **键盘/输入法无法注入** | ❌ 之前无记录，导致误判 |

## 二、移动端闭环（照基线补出来的六段）

**已经有一键脚本了**（照 `web-loop.sh` 的样子做的）：

```bash
./deploy/mobile-loop.sh                      # 全套七段
./deploy/mobile-loop.sh --device IP:端口     # 端口会轮换，需要时指定
./deploy/mobile-loop.sh --no-publish         # 只装机本地包，不发线上
./deploy/mobile-loop.sh --debug              # 装 debug 包（要 CDP 时；数据不丢）
./deploy/mobile-loop.sh --probe              # 额外跑坐标时序回归
./deploy/mobile-loop.sh --install-only       # 已发过版，只装 + 冒烟
```

七段：①可追溯性 ②tsc ③单测 ④**版本号自检（versionCode 必须比线上大）**
⑤打包 ⑥发布 + 装机 + 版本校验 ⑦真机冒烟（冷启动 / 崩溃栈 / 截屏）。
任一段失败 → 退出码非 0，由调用方自动返工。结尾会打印「需要你真手指验收」的清单。

手工分段（脚本跑不了时的退路）：

```bash
# 0 设备准备（会话开头做一次，之后不再重连）       → device-setup.md
ADB=/c/Users/小哭包/Android/platform-tools/adb.exe
"$ADB" start-server
MSYS_NO_PATHCONV=1 "$ADB" connect <IP:端口>

# 1 本地验证（与网页端共用）
npx tsc --noEmit && npm test && node tests/contrast.mjs && node tests/color-scan.mjs

# 2 打包（三件容易漏的事，漏了都不报错、只会悄悄不对）
bash deploy/build-apk.sh      # ①注入 VITE_API_BASE ②cap copy ③vite build + gradle

# 3 发布
bash deploy/publish-apk.sh "说明"     # 会读 APK 里的 versionCode/versionName，不信 build.gradle

# 4 装机 + 版本校验
MSYS_NO_PATHCONV=1 "$ADB" install -r "C:/.../apk"
MSYS_NO_PATHCONV=1 "$ADB" shell "dumpsys package space.xiaokubao.schedule" | grep -E 'versionCode=|pkgFlags'

# 5 真机断言（见下面「回归用例」）

# 6 真手指验收 + 数据清理（见下面「自动化边界」「数据卫生」）
```

## 三、回归用例（已有的三个工具，别再手写一遍）

| 工具 | 干什么 | 什么时候跑 |
|---|---|---|
| `deploy/cdp.mjs` | 真机 WebView 的 CDP 驱动：`eval` / 合成点击 / 灌字 / 按键 / adb 桥 / Network 域取证 | 需要读页面内部状态时 |
| `deploy/kbtiming.cjs` | 「点下去之后布局变了」的坐标时序回归（点 21:00 必须落 21:00） | 改日历点击/键盘相关逻辑后 |
| `deploy/kbprobe.cjs` | 量时间轴密度（每小时多少像素），判断键盘压缩后是否还可点 | 改日视图布局后 |

用法：

```bash
cd /c/Users/小哭包/coding/schedule-wt/app
NODE_PATH="$PWD/node_modules" node ../deploy/kbtiming.cjs
cd ../deploy && node cdp.mjs <IP:端口> --file <脚本.mjs>
```

⚠️ CDP 只对 **debug 包**有效（正式包没有 `webview_devtools_remote_*`）。
debug 包与 release 同签名 → 覆盖安装不丢数据。验收完记得装回正式包。

### 断言清单模板（每轮真机验收照这个填）

| 项 | 怎么验 | 通过标准 |
|---|---|---|
| 装机版本 | `dumpsys package` | versionCode/versionName 与发布一致，无 DEBUGGABLE |
| 冷启动 | 启动后 8s 截屏 | 进到主界面，无红条 |
| 数据同步 | 底部角标 | 「今天 N」「逾期 N」数字出现 |
| 本次改动的功能 | 针对性 CDP/截图断言 | 见任务本身 |
| 控制台零报错 | CDP 挂 `pageerror` | 无 |
| 数据卫生 | 列表里没有测试任务 | 无残留 |

## 四、自动化边界（**不能**用程序验证的，必须请用户看）

| 现象 | 为什么测不了 | 怎么办 |
|---|---|---|
| 输入法弹起 / 收起 | Android 只允许真实用户手势唤出键盘，adb 和 CDP 注入都不行 | 请用户真手指点，并明确告诉他要观察什么 |
| 键盘弹出后的布局 | 同上 | 同上 |
| 系统权限弹窗 | 系统级 | 同上 |
| 指纹/人脸 | 系统级 | 同上 |

⚠️ **别把「测不了」当成「没发生」**：2026-10-17 在这个坑上误判过两次
（以为「输入法闪一下」是注入造成的假象，结果用户真手指一样复现）。
用户报告的现象，优先当作真实 bug 查，不要先怀疑是测试工具的问题。

## 五、数据卫生

用 CDP 建过的测试任务（「探针3点」「验收0923」这类）**收尾必须删**，
否则留在用户账号里就是垃圾。删法：逾期/今天列表 → 多选 → 勾选 → 删除 → 确认；
单条就点开抽屉 → 右上角垃圾桶。
