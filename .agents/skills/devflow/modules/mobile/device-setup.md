# 设备准备与授权（Android 真机）

**何时读**：要用 adb 连手机之前。

## 一次性的准备（用户手机上做一次就行）

1. 设置 → 关于手机 → 连点「版本号」→ 打开开发者选项
2. 开发者选项 → **无线调试** → 打开
3. 那个页面上会给出两组信息，向用户要这两个：
   - **IP 地址和端口**，形如 `192.168.1.172:38237`（端口会轮换，2026-10-18 实测为 `38237`；每次连前以手机页面显示为准，别硬记旧端口）
   - **配对码**（6 位，几分钟失效）：只在首次配对时用

配对一次即可：`adb pair <IP>:<配对端口> <配对码>`。之后直接用连接端口：
`adb connect <IP>:<连接端口>`。

> ⚠️ **端口会轮换**：手机无线调试的端口每次开关都会变。旧端口连不上时，
> 别一直重试 —— 直接向用户要当前页面上显示的「IP 地址和端口」。

## 铁律：**一条命令内完成「连接 + 操作」，不要反复重连**

每次 `adb connect`（尤其是 adb 守护进程刚重启后）会在手机上弹「已连接到无线调试」
的系统通知。**用户明确抱怨过弹窗轰炸**（2026-10-17）。规则：

| 做法 | 结论 |
|---|---|
| 每个 Bash 命令开头都 `adb connect` | ❌ 禁止。一条命令一次弹窗，几十次就是几十条通知 |
| 先在一条命令里 `start-server` + `connect`，后续命令直接操作 | ✅ 首选 |
| 不确定连接还在不在 → 把 connect 和要执行的动作**串在同一条命令里** | ✅ 兜底做法 |

```bash
ADB=/c/Users/小哭包/Android/platform-tools/adb.exe
"$ADB" start-server                                   # 只在会话开头跑一次
MSYS_NO_PATHCONV=1 "$ADB" connect 192.168.1.172:32817 # 只在会话开头跑一次
# —— 之后所有命令不再 connect ——
MSYS_NO_PATHCONV=1 "$ADB" shell "dumpsys package space.xiaokubao.schedule"
```

## 连接掉了怎么办（按这个顺序，不要一上来就要用户操作）

```bash
ADB=/c/Users/小哭包/Android/platform-tools/adb.exe
"$ADB" devices                       # 1. 还在线吗
"$ADB" mdns services                 # 2. 手机还在广播无线调试吗（空 = 手机端关了/休眠）
"$ADB" connect <旧IP:旧端口>          # 3. 端口没变的话直接连回来
ping -n 2 -w 2000 <手机IP>            # 4. 手机还在线吗（ping 不通 = Wi-Fi 断了/休眠）
```

`mdns services` 为空且 ping 得通 → 手机端「无线调试」被关了，请用户打开并把新端口发来。
`mdns services` 有新端口 → 用新端口连。

## 让测试稳定（用完必须还原）

| 目的 | 命令 | 还原 |
|---|---|---|
| 屏幕不休眠 | `adb shell svc power stayon true` | `... stayon false` |
| 点亮屏幕 | `adb shell input keyevent 224` | — |

⚠️ 这两项改的是**系统设置**，收尾一定要还原（用户不看得到这个开关被谁改的）。

## 手机端的干扰项

- **App 切后台会被挂起**：CDP 会话在后台会超时无响应。每次验收前 `am force-stop` + 重新启动。
- **`monkey` 启动常把 App 留在后台**：纯 `monkey -p …` 拉起后，前台可能还是别的 App，
  WebView 不建调试通道，`/proc/net/unix` 里 `webview_devtools_remote_*` 为空，CDP 连不上。
  **拉到前台要显式 `am start -n space.xiaokubao.schedule/.MainActivity`**。`android-live-check.mjs`
  和 `cdp.mjs --relaunch` 内部都已这么处理。
- **系统省电策略**：可能杀掉后台 App，表现为 pid 变了。用 `pidof` 判断时要小心 ——
  自己刚 `force-stop` 过的话 pid 变化是正常的，别误判成「App 在崩溃」。
- **VPN / 代理 / 私人 DNS**：会影响 WebView 的网络，排查见 `troubleshooting.md`。
