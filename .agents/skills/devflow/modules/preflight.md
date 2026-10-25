# 前置自检（preflight）

**何时读**：devflow 进任何动作前的第 0 步（和抢锁一起）。

目的：先确认工具链齐了，别跑到一半才发现 node 不对 / 没登录 / 设备没连。

## 检查清单

| 项 | 怎么查 | 不过怎么办 |
|---|---|---|
| Node 版本 | `node -v`（需要 22+） | 用托管运行时 `C:/Users/小哭包/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` |
| git 直连 GitHub | `git ls-remote github` 不报错 | **先原样重试一次**（多为瞬时故障）；仍不通试 SSH insteadOf（`git -c url."ssh://git@github.com/".insteadOf="https://github.com/" <命令>`）。系统代理会让 git schannel 挂起而 curl 通——别一头扎进代理排查，详见工程 `docs/踩坑-环境.md` |
| gh 登录态 | `gh auth status` | **不阻塞**：gh 报 keyring 失败不影响 git 推送（git 走 Windows 凭据管理器）；只有明确要调 gh API 时才提示 `gh auth login` |
| Playwright 的 Chrome | 网页端发版要用；`app/node_modules/@playwright/test` 存在 | 缺则用系统 Chrome；仍缺提示安装 |
| （仅安卓端才查）adb 连通 | `adb devices` 列出手机 | 按 `mobile/device-setup.md` 连接；连不上先别跑安卓流程 |

## 规则

- 缺**必备**项（node / git）→ 停下告诉用户，不硬跑；gh 不算必备（登录态失败不挡推送，见上表）。
- 只走网页端时，adb 不查也不报错。
- 本检查只读，不动任何文件、不抢锁。
