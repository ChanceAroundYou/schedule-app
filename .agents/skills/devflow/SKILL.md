---
name: devflow
description: "日程项目的完整开发工作流编排器，是 refine 的下游。refine 判定任务适合走工作流（会改代码/文件/配置/线上）后自动接管；用户也可用大白话触发单步动作（存一下/推一下/同步一下/发线上/别发/看状态/审查一下/有冲突吗）。负责：前置自检 → 抢并发锁 → 执行 → 默认 commit（提交前轻量校验）→ 自动代码审查 → 自动 push/pull → 发版（网页端和安卓端都默认自动发+实测，各有对应 e2e：网页 live-check.mjs / 安卓 android-live-check.mjs）→ 验证+回滚 → 汇报。复用 schedule-sync（只做 push/pull 执行器）与 schedule-deploy（发版兼容壳）作为底层执行器。"
agent_created: true
---

# 完整开发工作流（devflow）

> 本 skill 是「完整工作流」的编排器。**refine 是入口 + 方案闸门**；判定任务适合走工作流后，
> 由本 skill 接管后续所有执行步骤。refine 只出方案，不碰执行。
>
> 发版兼容壳 `schedule-deploy`、同步执行器 `schedule-sync`、报障 `schedule-bug`
> 都是本流程调用的底层执行器，不在 refine 里直接出现。

## 触发

- **refine 交接**：refine 在方案确认且判定"适合工作流"后，自动把任务交过来；
- **用户直接触发单步动作**（大白话即可）：

| 用户说 | 我做什么 |
|--------|----------|
| "存一下" / "提交" | 只 commit（本地保存，不推不拉、不审查） |
| "审查一下" / "检查一下代码" | 只跑 xaction-code-review 对本次改动体检，不推不拉不发布 |
| "拉一下" / "下载最新" | 只从 GitHub 拉最新到本地 |
| "推一下" / "上传改动" | 先过代码审查（除非你说别审）+ commit + 只把本地推到 GitHub |
| "同步一下" | commit + 代码审查 + pull + push 全做 |
| "发线上" / "发布" | 走发版（**网页端和安卓端都默认自动发 + 实测**，各有对应 e2e：网页 live-check.mjs / 安卓 android-live-check.mjs） |
| "别发" / "先别动线上" | 跳过发布 |
| "看状态" / "现在到哪了" | 汇报进度 + 审查结果 |
| "有冲突吗" | 检查本地和云端会不会打架 |

> 单步语义以本表为**唯一来源**；`schedule-sync` 只作底层 push/pull 执行器，不再重复定义这些快捷键。

## 模块索引（执行细节，按需读，不要一次全读）

本 skill 的执行细节拆到 `modules/`，用到哪块读哪块：

| 模块 | 何时读 |
|------|--------|
| `modules/preflight.md` | **进流程第一步**——node/gh/adb/Playwright 前置自检 |
| `modules/lock.md` | **进流程第一步**——抢 session-claim 并发锁，防两个 AI 会话同时改同一份副本 |
| `modules/workspace-safety.md` | **每次动 git / 发布之前**——并行开发保护硬规则（分支策略、保全、禁止清单，必读） |
| `modules/web-flow.md` | 走分支 A 网页端发版时 |
| `modules/android-flow.md` | 走分支 B Android 端发版时（含版本号两处同源） |
| `modules/mobile/device-setup.md` | 要连安卓真机之前 |
| `modules/mobile/adb.md` | 要装 APK / 截屏 / 取日志之前 |
| `modules/mobile/mobile-test.md` | 真机回归验证之前 |
| `modules/mobile/troubleshooting.md` | 真机「打不开 / 连不上 / 点了没反应」时 |
| `modules/report.md` | 第 6 步「汇报」时——落盘一份结构化发布纪要，方便以后回看 |

## 标准流程（适合工作流的任务）

**0. 前置自检 + 抢锁（进任何动作前）**
   - 先读 `modules/preflight.md`：检查 node 版本、gh 登录、Playwright 的 Chrome、以及（若走安卓）adb 连通。缺什么先提示你装/连，别跑到一半挂。
   - 再读 `modules/lock.md`：在仓库 `.git/devflow.lock` 写会话 ID+时间戳抢锁；若锁属其他近期会话，停下报告「另一会话正在跑工作流」，不抢。结束/出错删除锁。

1. **执行改动**：严格按 refine 已确认的方案写代码 / 改文件，不做 scope 外的事。
   - **动 `app/src/views/`、`app/src/styles/` 前先查 `docs/` 定案**（`grep -n 关键词 docs/*.md`，
     关键词如：周视图、锁单屏、拖拽、键盘、时间轴）。设计定案的唯一真相源是 `docs/`，
     不是 AI 记忆——2026-10-24 教训：定案只在记忆里 → 并行会话按旧记忆改回去 →
     用户看到"回退"（6504386 事件）。查到定案 → 遵守；要改定案 → 先问用户。

2. **默认 git commit**：动 git 前**先读 `modules/workspace-safety.md`**，按它的五条保全检查
   （status / stash list / ls-files -u / log / branch）+ 禁止清单执行，绝不误覆盖别人的改动。
   - **提交前轻量校验（拦掉编不过的提交）**：改了前端 TS → `cd app && npx tsc --noEmit`；
     改了 server → `node --test server/tests`；都过再提交。（代码审查不替你编译，这步是门前关。）
   - 本地验证通过直接提交，不每轮问；只用 `git add <具体文件>`（不用 `-A`）；
     例外是用户说"先别提交"。

3. **自动代码审查（质量门，默认跑）**：commit 后、推云端前，跑 `xaction-code-review`
   做多维度体检（正确性 / 可读性 / 架构 / 安全）。**严重问题（会崩 / 泄密 / 出错）停下问用户**；
   小问题（命名 / 注释 / 风格）不挡路、记进汇报继续走。例外：用户说"别审查"。

4. **自动 push + pull（默认）**：推送前同样按 `modules/workspace-safety.md` 的「推送前安全网」
   体检（先 `pull --rebase`、确认要推的就是本任务那几个提交）。审查后自动和 GitHub `dev`
   对齐（先拉后推），能自动合并就直接做、不问；**只动 `dev`，不碰 main / ubuntu 工作区 / 其他分支**；
   **严重冲突无法自动合并时停下问用户**（给选项：保留哪边 / 让我挑重要的），绝不擅自覆盖。
   （分支策略细则见 `modules/workspace-safety.md`，本步骤不重复定义。）

5. **发版（两端都默认自动发 + 实测）**：
   - **网页端 / 服务端改动 → 默认自动发 + 线上实测**：读 `modules/web-flow.md`，
     直接跑 `./deploy/web-loop.sh`（自动发 + `live-check.mjs` 打生产 URL 实测，
     失败自动返工 ≤3 轮，还不过停下汇报）。**不再每轮问"发吗"**。
     （注意：`web-loop.sh` 自己就是放行闸，**没有 `--approve` 参数**——那个参数只有
     `publish-server.sh` / `publish-web.sh` / `publish-apk.sh` 有，别给 web-loop 传。）
   - **安卓端改动（改了 `app/android/`、`versionCode`、原生插件、小组件）→ 同样默认自动发 + 真机实测**：
     跑 `./deploy/mobile-loop.sh`（自动版本号自检 → 打包 → 发布 → 装机 → 版本校验 → 真机冒烟），
     再由 **`app/tests/android-live-check.mjs`**（镜像网页端 `live-check.mjs` 的
     core/now-line/repeat 断言，通过 CDP 打真机 WebView）跑端到端实测：
     `node app/tests/android-live-check.mjs --device <IP:端口>`。连设备/装包/真机回归按需读 `modules/mobile/`；
     **先网页端再 APK 的顺序铁律不变**。
   - **破坏性 / 不确定改动**（改了同步协议、DB schema、鉴权）→ 无论哪端都先问你再发。
   - **发版后统一"验证 + 回滚"关卡**：web 看 `live-check.mjs` 断言全绿、安卓看
     `android-live-check.mjs`（兜底用 `mobile-loop.sh` 第七段真机冒烟）；任一失败立刻
     `publish-web.sh --rollback --approve` 或重装上一版 APK，并马上报告你。

6. **汇报 + 落盘纪要**：用一两句大白话在聊天里告诉用户：改了什么、已提交、代码审查结果、是否已同步云端、是否已发布、线上实测结论。同时读 `modules/report.md`，按模板在 `runs/` 目录存一份结构化发布纪要（以后能翻）。聊天是即时通知，纪要是存档，两者互补。

## 原则

1. **职责分明**：refine 出方案、devflow 跑执行；refine 不会在出方案后自己偷偷跑执行。
2. **闸门在外**：凡"纯问答 / 查资料 / 闲聊 / 只读 / 纯方案讨论"的任务，refine 的闸门会判为
   不进工作流，本流程根本不会被触发——这类任务连 commit 都不会发生。
3. **先问再动生产（只限破坏性）**：网页端与安卓端都默认自动发 + 实测（你的要求：
   无论哪端都立刻看到变化）。只有**破坏性 / 不确定改动**（同步协议、DB schema、鉴权）
   才先问你。严重冲突、严重隐患无论哪端都先问，绝不擅自覆盖或擅自动生产。
4. **复用执行器**：提交 / 审查 / 同步交给 `schedule-sync`（只做 push/pull），发版交给 `schedule-deploy`，
   本 skill 只做编排，不重复造轮子。

## 反面教材

- refine 出完方案就自己闷头写代码、提交、发版——那是越权，执行必须在本流程里。
- 纯问答也跑了一遍 commit / push——闸门没拦住，应在 refine 就判为"不进工作流"。
- 严重冲突时擅自覆盖云端——无论哪一步，冲突都先停下来问用户。
- 两个 AI 会话同时跑本流程改同一份副本——必须靠 `modules/lock.md` 的锁互斥，不能靠"看见了就停"的人肉规则。
