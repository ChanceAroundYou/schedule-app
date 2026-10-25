# 移动端常见故障排查

**何时读**：真机上出现「打不开 / 连不上 / 点了没反应」之后。

总原则：**先分层定位，再动手改**。移动端最容易犯的错是一上来就改业务代码，
而真正的故障往往在传输层或打包环节。

## 一、定位的第一刀：分清是「哪一层」坏了

```
① 服务端活着吗？        curl https://<域名>/schedule/api/health   → 200 才往下走
② 手机网络通吗？        adb shell ping <域名> / <内网IP>
③ 系统浏览器通吗？      adb shell am start -a VIEW -d <URL>       → 能打开 = 网络没问题
④ 原生网络通吗？        点 App 里的「检查更新」（走 HttpURLConnection）
⑤ WebView 内部通吗？    CDP 里 fetch 同一个 URL
```

**③ 通而 ⑤ 不通** → 问题在 App 的 WebView，不是服务端、不是网络、不是域名。
这时用 CDP 的 Network 域拿浏览器底层错误码，别在页面里瞎猜：

```
Runtime.enable + Network.enable → loadingFailed 事件的 errorText
    常见：net::ERR_NAME_NOT_RESOLVED（DNS）
          net::ERR_CERT_AUTHORITY_INVALID（证书）
          net::ERR_BLOCKED_BY_PRIVATE_NETWORK（PNA）
```

`deploy/cdp.mjs` 已经会打印 `net::ERR_*` 和 `blockedReason`。

## 二、典型故障与解法

| 症状 | 根因 | 解法 |
|---|---|---|
| App 一直挂「连不上服务器」红条，网页版正常 | WebView 的 DNS 解析整体失效（连 baidu 都 `ERR_NAME_NOT_RESOLVED`），而系统 ping / 系统浏览器 / 原生请求全正常 | 启用 `CapacitorHttp`（请求改走原生网络栈）。本项目已启用 |
| 请求 20–30ms 内失败、`transferSize=0` | 请求还没发出网就被拦了（DNS / PNA / CSP） | 按第一节分层，别当成超时处理 |
| 手机浏览器能开，App 里不行 | ①WebView DNS ②证书链不完整（桌面 curl 会自己补，Android 不会）③少 PNA 头 | 逐项排除，见下 |
| 证书 `Verify return code: 20` | 服务端没发完整证书链（缺中间证书） | 修 nginx 的 `ssl_certificate` 配 fullchain |
| `Access-Control-Allow-Private-Network` 缺失 | 域名解析到内网 IP（192.168.x.x），Chrome 115+ 对 local→private 强制预检 | 服务端对白名单来源补这个头（本项目 `server/http.js` 已加） |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | debug 包与正式包签名不同 | 装正式包，或给 debug 挂同一个 keystore |
| 正式版 `webview_devtools_remote_*` 为空 | 正式包关了调试（安全上正确） | 装同签名 debug 包做 CDP，验完装回正式包 |
| CDP 连上但无响应 / 超时 | App 被切后台挂起或屏幕休眠 | `force-stop` + 重新启动 + `svc power stayon true` |
| `adb devices` 空 / 连不上 | 端口轮换、手机休眠、无线调试被关 | 见 `device-setup.md` 的掉线处理顺序 |
| 点屏幕没反应 | ①坐标算错（目测失真）②点到了遮罩层 ③App 在别的状态 | 用 `pix.py` 定位；CDP 里 `elementFromPoint` 看那个点上到底是什么 |
| adb 点击有效但页面无响应 | 可能是 App 的点击走委托、或该区域有 `data-act` 早退 | 先确认点击是否真的送达（装监听看 target） |

## 三、避坑清单（都是踩过的）

1. **别把焦点当意图信号**：安卓键盘弹起会改变 App 高度、布局重排，输入框会在
   200–400ms 之间被系统自己弄丢焦点。拿失焦当「用户放弃」就会「输入法闪一下就没了」。
2. **别用 `visualViewport` 差值判键盘高度**：App 是 adjustResize，`innerHeight`
   与 `vv.height` 一起变小，相减恒等于 0。要用 `@capacitor/keyboard` 的原生事件。
3. **坐标与 rect 必须同一时刻取**：`e.clientY` 是按下那一刻的，
   `getBoundingClientRect()` 读到的是处理那一刻的。键盘正好在这之间收起时，
   21:00 会算成 7:00（实测偏 14 小时）。坐标要按 pointerdown 的快照算。
4. **打包别跳过 `build-apk.sh`**：直接跑 gradle 会漏掉 API 基址注入，
   表现是「App 连不上服务器」，而且不报错。
5. **别反复 `adb connect`**：每连一次手机弹一次通知，用户会被烦死。
6. **改过的系统设置要还原**：`svc power stayon`、输入法开关等。
7. **用户报告的现象先当真 bug**，别先归咎于测试工具的局限。
