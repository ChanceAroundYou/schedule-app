# ADB 操作手册

**何时读**：要安装 APK、截屏、取日志、用坐标点屏幕之前。

```bash
ADB=/c/Users/小哭包/Android/platform-tools/adb.exe
```

包名：`space.xiaokubao.schedule`　主 Activity：`.MainActivity`

## 一、路径转换（Git Bash 上最大的坑）

| 场景 | 写法 | 说明 |
|---|---|---|
| **远端 Unix 路径参数** | 加 `MSYS_NO_PATHCONV=1` | 否则 `/data/local/tmp/a.apk` 会被转成 `C:/Program Files/Git/data/...`，空格一切命令就废了 |
| **本地路径** | 写成带盘符的 `C:/...` | 不要依赖 `/c/...` 的自动转换 |
| 远端 shell 命令 | 整体用单引号包裹 | `adb shell "input tap 600 923"` |

```bash
MSYS_NO_PATHCONV=1 "$ADB" install -r "C:/Users/小哭包/.../app-debug.apk"
```

## 二、安装与启动

```bash
MSYS_NO_PATHCONV=1 "$ADB" install -r "C:/.../apk"          # 覆盖安装，保留数据
MSYS_NO_PATHCONV=1 "$ADB" shell am force-stop space.xiaokubao.schedule
MSYS_NO_PATHCONV=1 "$ADB" shell "am start -n space.xiaokubao.schedule/.MainActivity"
```

**装机后必校验**：

```bash
MSYS_NO_PATHCONV=1 "$ADB" shell "dumpsys package space.xiaokubao.schedule" | grep -E 'versionCode=|versionName=|pkgFlags'
```

- `versionCode` / `versionName` 必须与发布的一致
- `pkgFlags` **不能**出现 `DEBUGGABLE`（那是调试包；正式包不该有）

### 签名不匹配的症状与解法

`INSTALL_FAILED_UPDATE_INCOMPATIBLE`（签名不同）→ 你装的是 debug 包、手机上是正式签名版。
**正式版与调试版签名不同就不能互相覆盖**。要能用 CDP 调试又不丢数据：
在 `app/android/app/build.gradle` 给 debug 构建类型挂同一个 keystore（本项目已这么做）。

## 三、日志

```bash
MSYS_NO_PATHCONV=1 "$ADB" shell logcat -c                       # 先清空
MSYS_NO_PATHCONV=1 "$ADB" shell "logcat -d 2>/dev/null | tail -40"
MSYS_NO_PATHCONV=1 "$ADB" shell logcat -b crash -d               # 崩溃缓冲
MSYS_NO_PATHCONV=1 "$ADB" shell "logcat -d | grep -iE 'FATAL|AndroidRuntime|died' | tail -15"
```

没有崩溃栈 ≠ 没崩溃：可能只是被系统回收/挂起。配合 `pidof` 与 `dumpsys activity processes`
的 `lastActivityTime` 判断。

## 四、截屏与像素分析

⚠️ `adb exec-out screencap` 在这台机器上**不稳定**（有时输出不是 PNG、有时空）。
用「存到手机再拉」这条路：

```bash
MSYS_NO_PATHCONV=1 "$ADB" shell "screencap -p /sdcard/s.png"
MSYS_NO_PATHCONV=1 "$ADB" pull /sdcard/s.png "C:/Users/小哭包/AppData/Local/Temp/cur.png"
```

⚠️ **pull 的目标必须是 Windows 盘符形式**（`cd /tmp && pwd -W` 现取）。
这条命令同时带远端 Unix 路径（靠 `MSYS_NO_PATHCONV=1` 才不被转坏）和本地路径，
写 `/tmp/x.png` 会因为转换被关掉而变成一个 Windows 上不存在的目录 → 拉不到，
而且**不报错**（实测踩过：单独跑正常、放在脚本里就空文件）。
远端 sdcard 写入偶发失败，重试一次即可。

`exec-out` 拿到的是裸 RGBA（16 字节头 + 像素），要自己转 PNG —— 见 `deploy/pix.py`。

### 坐标：别靠目测

| 量 | 取值 |
|---|---|
| `adb shell wm size` | **物理像素**（如 1080×2376），`input tap` 用这个坐标系 |
| `getBoundingClientRect()` | **CSS 像素**（页面内坐标） |
| DPR | `density / 160`，如 480 → 3.0 |

⚠️ **用 Read 看图目测坐标必然错**：工具显示的图片是缩放过的。要精确位置就用
`deploy/pix.py`（纯标准库解 PNG + 按行扫描），先用已知锚点（如当前时间绿线）
反推出「00:00 在哪个 y、每小时多少像素」，再算目标位置。

## 五、输入

```bash
adb shell "input tap 600 923"                    # 点
adb shell "input swipe x1 y1 x2 y2 300"          # 滑（按住时长 ms）
adb shell input text 'abc'                       # 打字（不含中文/空格）
adb shell input keyevent 4                       # BACK（收键盘）
adb shell input keyevent 66                      # ENTER
adb shell input keyevent 224                     # 点亮屏幕
```

⚠️ **adb 注入的点击唤不出软键盘**（Android 只允许真实用户手势弹输入法）。
凡是与键盘/输入法有关的现象，**不能用 adb 复现**，只能请用户真手指验收。

## 六、本机侧常用查询

```bash
"$ADB" shell "dumpsys package space.xiaokubao.schedule"   # 版本/权限/uid
"$ADB" shell pidof space.xiaokubao.schedule                # 进程在不在
"$ADB" shell "ime list -s"                                 # 输入法
"$ADB" shell "dumpsys input_method | grep mInputShown"     # 键盘是否可见
"$ADB" shell "cat /proc/net/unix | grep -o webview_devtools_remote_[0-9]*"  # 调试通道在不在
```

`webview_devtools_remote_*` 为空 = 正式包（关了调试）。要用 CDP 就装同签名的 debug 包。
