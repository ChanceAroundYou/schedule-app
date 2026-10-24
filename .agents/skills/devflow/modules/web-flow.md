# 分支 A · 网页端（默认）

**何时读**：改动落在 `app/src`、`server/`、样式、文案、纯前端逻辑。

## 一条命令跑完五段

```bash
./deploy/web-loop.sh                # 全套（含本地深测，约 3~5 分钟）
./deploy/web-loop.sh --fast         # 跳过本地深测（小改动/赶时间）
./deploy/web-loop.sh --no-publish   # 只测不发
./deploy/web-loop.sh --server-only  # 只发服务端
```

| 段 | 内容 | 失败时 |
|---|---|---|
| 1 | **可追溯性**：发布路径（`app/src`、`app/index.html`、`app/tests`、`server/`、两份 package*.json）有未提交改动就拒发 | 先 commit |
| 2 | `tsc --noEmit` | 修类型 |
| 3 | 单测：app（`src/**/*.test.ts`）+ server（`server/tests/*.test.js`） | 修逻辑/补断言 |
| 4 | **本地深测**：`browser-smoke.mjs`（临时库 + 临时后端 + 真实 Chrome，全流程，436 条断言） | 修交互 |
| 5 | **发布 + 线上实测**：`publish-server.sh --approve` + `publish-web.sh --approve`（内容没变自动跳过）→ `live-check.mjs`（Playwright 打生产 URL） | 见下 |

任何一段失败 → 自动返工（修 → 重新 commit → 重跑），最多 3 轮；
3 轮还不过就停下，用大白话告诉用户卡在哪、具体报什么。

## 线上实测（`app/tests/live-check.mjs`）检查什么

- `core`：登录 → 日/周/月三视图渲染 → 零控制台报错
- `now-line`：当前时间线是 `--ok` 深绿、无圆点无时刻文字
- `repeat`：API 建「每周五、六」系列 → 断言周五+周六实例都落到月视图 → repeatUntil 收尾
- 机器人账号 `e2e-bot / e2e-bot-2026`（生产库里这一个测试账号，自动注册/登录）

## 没人会踩的坑（记下来省时间）

- 登录后默认落在「今天」**列表页**；时间轴和日/周/月切换要先点 `[data-nav="calendar"]`。
- `npm run build` / `vite build` 出的 dist 不带 API 基址，只有 APK 打包才注入 ——
  所以**先发网页端，再打 APK**。
- 发布脚本默认 dry-run（不带 `--approve` 只打印摘要、退出码 1）；
  `web-loop.sh` 是替用户判断过的自动放行，它自己做了可追溯性检查。
- `--allow-dirty` 只在「脏文件全在发布路径之外」时用（例如 `deploy/` 下的草稿脚本）。
- 动 `app/src/views/`、`app/src/styles/` 前先 `grep` 一遍 `docs/` 定案（周视图锁单屏、
  拖拽分身方案都在里面）。定案以 docs 为唯一真相源，别照记忆改——2026-10-24
  6504386 就是这么被并行会话覆写过一次的。

## 纯前端逻辑的浏览器验证

手机特有的问题，先在网页版用 Playwright 复现一次，能把「代码问题」和
「手机特有问题」分开（`deploy/kbprobe.cjs`、`deploy/kbtiming.cjs` 就是这么做的）：
改变视口高度可以模拟键盘压缩，不需要真机。
