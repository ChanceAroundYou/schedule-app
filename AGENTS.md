# 日程清单

个人用的任务与打卡应用。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
**前后端分离**：React 前端 + 自写 Node 后端 + SQLite，数据在服务器上。

**改代码前先读 [docs/踩坑.md](docs/踩坑.md) 和「三、界面硬规则」。**
本文「**踩坑 N**」= `docs/踩坑*.md` 里编号为 N 的那一条。**编号是稳定引用，别改。**

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | **本文 —— 往哪走**：结构、不变量、界面硬规则、给 AI 的硬约束 |
| [docs/业务模型.md](docs/业务模型.md) | 完整字段表、重复规则、逾期、冲突提示、AI 三段式详情 |
| [docs/界面约定.md](docs/界面约定.md) | 配色与令牌、变量名对照表（另有 `-无障碍` / `-布局` / `-快速添加` 三册） |
| [docs/踩坑.md](docs/踩坑.md) | **改代码前先读**：54 条坑的索引 |
| [docs/测试.md](docs/测试.md) | 怎么验、每条约定锁在探针哪一节 |
| [docs/接口.md](docs/接口.md) | HTTP 接口总览 + 认证（另有 `-日程集` / `-同步` / `-AI` 三册） |
| [docs/架构决策.md](docs/架构决策.md) | **为什么是现在这样**：选型、同步、多账户、小组件、不做的事 |
| [DEPLOY.md](DEPLOY.md) | 拓扑、发布、nginx / conf、排障 |
| [README.md](README.md) | 给人看的：网址、怎么用、日常命令 |

---

## 一、结构

```text
日程管理/
├── app/          前端（React + TS + Vite）
│   ├── src/App.tsx    启动 / 登录分流，不碰业务状态
│   ├── src/app/       工作台：Workbench.tsx 组装 + 兄弟模块（点击委托、拖拽、浮层等）
│   ├── src/domain/    纯逻辑，零 React / DOM / 网络
│   ├── src/data/      localStorage + 接口封装 + 旧数据导入
│   ├── src/sync/      同步引擎：outbox 推送 + 游标拉取
│   ├── src/ui/        侧栏 / 顶栏 / 抽屉 / 拖拽 / 日程集 / 设置 / AI 面板
│   ├── src/views/     纯展示，零回调，只出 data-* 属性（含项目泳道看板）
│   └── src/styles/    语义样式模块 + tailwind.css
├── server/       后端（Node 22，只引 AI 那一组依赖）
│   ├── server.js      路由表 + 处理器 + 鉴权中间件
│   └── lib/           db · auth · sync · calendars · invites · ratelimit · ai/
├── deploy/       发布脚本 + nginx conf / systemd 单元
└── dist/         构建产物（勿手改）· docs/
```

**线上只有 `~/.local/schedule/web` 被 nginx 伺服**，源码 / `server/` / 文档一律 404。
工程里的 `dist/` 只是本地产物，**不等于上线**（见 [DEPLOY.md](DEPLOY.md)）。

### 三层状态，别混

| 层 | 在哪 | 谁是真相 |
|---|---|---|
| 领域模型 | `state.tasks` / `state.habits`（按 id 索引的对象，不是数组） | ← |
| 本地存储 | localStorage `schedule-app-v4` | 离线副本 |
| 服务端 | SQLite `~/.local/schedule/data/schedule.db` | **权威** |

排查「数据不对」**先看服务器**。运行方式见 README.md。

### 点击与视图

点击在 `#content` 上委托（`app/clickDispatch.ts`），`views/` 全纯展示、零回调、只出 `data-*`。
分派顺序 `[data-act]` → `[data-jump]`/`[data-nav]` → `.task-el` → `[data-zone-id]`。
Workbench 给视图传哪份 state（`state` 全量 / `scoped` 按集）决定「哪些页面跨集」：
今天 / 逾期 / 待办箱 / 垃圾箱 / AI 看全部；日程 / 打卡 / 已完成 / 项目只看选中集。
导航 `NAV_ALL` = `inbox · today · overdue · calendar · projects · habits · done · ai · trash · settings`。
`ui.tabs ← ui.navOrder` 只有 `orderTabs()` 一个出口（[踩坑 49](docs/踩坑-前端-组件.md)）。

---

## 二、不变量（**最要紧**）

> 推导、字段表、失败症状 → [docs/业务模型.md](docs/业务模型.md)。这里只留「不许破」。

### 数据结构六条

1. `tasks` / `habits` 是**按 id 索引的对象**，不是数组。
2. `calId` 是**主键的一部分**，不是可同步字段 → **挪集 = 目标集新建 + 源集留墓碑**。
3. **删除是墓碑**：`deleted` 让别的设备知道要删，`purged` 才到处看不见。
4. **三态各自独立**：未定时（`time===null`）· 未定日期（`date===null`）· 已完成仍占日程位置。**只有第二态进待办箱。**
5. **待办箱 = `date === null` 的未完成任务**；未定时是另一回事。
6. **任务与打卡独立**，`habits.log` 是按日期的稀疏映射。

不做长篇幅记录：备忘录 / 清单 / 笔记本已整体删除，迁移是**丢掉不是归档**。别再加回来。

### 权限

没有管理员，所有人平等，开放注册。共享单位是集，不是任务。

| 角色 | 改任务 / 打卡 | 改集与成员 |
|---|---|---|
| `owner` | ✅ | ✅ |
| `editor` | ✅ | ❌ |
| `viewer` | ❌ | ❌ |

判断只有 `canWrite(role)` / `canManage(role)`（`domain/types.ts`）与服务端 `db.roleOf()` / `calendars.canWrite()`。别在别处写 `role === 'owner'`。
三条不变量：① 每人永远至少一个集；② 每集永远至少一个 owner；③ 写权限在写入通道把关（`store.commitMany()` 与 `sync.applyOps()` 各挡一次），不是靠界面藏按钮。邀请两段式。

### 同步

`changes.seq` 全局单调，客户端只存一个 `cursor`，服务端按 `cal_id IN (我的集)` 过滤。
新加入一个集时其历史变更全在游标后面 → 客户端见不认识的 `calId` 就再要一次全量快照（`engine.ts` `syncNow()` 的 `known` 判断）。
`POST /api/sync` 一次调用同时推和拉，服务端先落盘再取数。集 / 成员 / 邀请走普通 REST，不走 LWW。LWW 逐字段（[踩坑 3](docs/踩坑.md)）；同字段两边都改过时抽屉里多一条只读提示，提示不改数据。

### AI

AI 是「另一台设备」：读走 `sync.snapshot(userId)`，写走 `sync.applyOps(userId, ops)`，`deviceId` 固定 `'ai'`。`snapshot()` 已按 `calendarIdsFor()` 过滤、已剔墓碑；`applyOps()` 里有 `canWrite(...)`，是唯一服务端把关点。
写路径三段：**工具 → 提案 → 确认**。写工具的 `execute` 只造提案不落库（`Map<toolCallId, proposal>`，结构性保证）；提案按 `toolCallId` 关联消息（pi 默认并行）；`POST /api/ai/confirm` 是唯一落库处，**只信 id 不信参数**，按 id 读回提案、重查权限、再走 `applyOps`。提案存的是 `fields`（最终落进 op 的字段），不是意图。详情见 [docs/业务模型.md](docs/业务模型.md) 与 [docs/接口-AI.md](docs/接口-AI.md)。

### 重复规则 / 逾期

- 防死循环判据：`while (next && next < today && next > cursor)`。别换回魔法数字。
- 实例 id 派生：`` `${根}#${发生日}` ``。两台设备离线推进派生同一 id，同步时合并。
- 逾期唯一口径：`!done && date && date < today`。`counts().today` 不含逾期。

---

## 三、界面硬规则（**跨切面**）

> 像素与推导 → [docs/界面约定.md](docs/界面约定.md) 及三册分册。这里只留「不许破」。

### 交互与视觉语言

交互统一「列表 → 详情 → 编辑」三段式；删除走应用内确认弹层（`useConfirm`）。
- 界面不出现「备忘录」「笔记本」「清单」；文案统一「打卡」不是「习惯」（`habits` 名保留）。
- 任务是「标题 + 详细内容」，字段名仍是 `note`（改名等于数据迁移）。
- 点日历空格子 = 就地新建，落点由点的位置决定，回车落成、Esc 取消。抽屉不是新建入口。
- 深浅色两档（`ui.theme`）、风格三档（`ui.style` → `data-style` + tokens）。色板没有。
- 图标一律 lucide，零 emoji；弹层一律应用内，零原生 `confirm` / `alert`。

### 令牌五条

1. `.tsx` 引用变量一律不给兜底值。
2. `--border`（装饰线）与 `--input`（交互描边 ≥3:1）按「能不能操作」分档；焦点环在 `styles/responsive.css` 最末 `:focus-visible`，必须和 `--input` 一起改。
3. 风格轴两半：线粗细 `--border-w`，圆角 `--r-*`；`.tsx` 不许出现 Tailwind 自带 `rounded` / `rounded-lg` / `rounded-2xl`。
4. 卡片圆角：`min(var(--r-xl), max(2px, calc(var(--card-h) * var(--card-r-k))))`，每种卡把高度报进 `--card-h`。同一属性只声明一处。用 `min()`/`max()` 不用 `clamp()`。横向留白只有 `--card-pad-x`，容器横向 padding 一律 0。
5. 勾选圈视觉直径 = 所在行字号 × `--check-k`，夹 `--check-min`~`--check-max`（现 k=1、夹 9~18px）。别在 `.tsx` 或响应式里再写一档尺寸。

### 时间与卡缝

- 时间行只由时长决定：`> 60 分钟` 一定有，`≤ 60`（含整 1 小时、含没设时长）没有；月视图永远没有（时间挂 `title`）。判据只在 `TaskCard` 一处。
- 上下把手：`≥ 60 分钟` 一定有两个；`< 60 分钟` 才受 26px 门槛管。
- 卡缝四边都是 1px（`CARD_SEAM`）：上/下/右由 `TaskCard.tsx` 内联扣，未定时卡右边在 `calendar.css` 的 `.task-el--untimed` 扣，间距容器 `--un-gap: 1px`。单列也要扣。
- 装不下只许压不许加长：`useCardFit` 两轴分别压（纵向行距→留白→标题字号；横向紧凑写法→字距→时间行字号）。横向不许动标题字号。两轴档位写在卡上 `data-fit`。

### 页面跨集 / 只读 / 文案 / 状态 / 无障碍

- 跨集口径：今天 / 逾期 / 待办箱 / 垃圾箱 / AI 看全部；日程 / 打卡 / 已完成 / 项目只看选中集（`ui.cals`）。勾选（`ui.cals`）和归属（`ui.cal`）是两件事。
- 只读成员：点了会告诉你为什么（`commitMany()` 挡下时 `denied` +1，弹一次提示，提示要点名是哪个集）。
- 文案：默认不写，写就一句，危险后果 / 反直觉 / 不可逆才写。
- 断网时顶栏 `.sync-dot` 显示 ☁︎ 划掉（`CloudOff`），来源 `ui/hooks.ts` 的 `useOnline()`。
- 没有密码找回、邮箱、第三方登录、管理员。别在界面上提「管理员」。
- 无障碍：每个控件要有可访问名字（placeholder 不算）；勾选圈走 `views/parts.tsx` 的 `<CheckBtn>`；命中区 ≥24×24；浮层四件事（`role="dialog"` + `aria-modal` + 名字 · `useFocusTrap` · 焦点送面板本身 · 关时还回）；`prefers-reduced-motion` 全站关。

---

## 四、最容易翻车的九条

> 完整 54 条见 [docs/踩坑.md](docs/踩坑.md) 的索引（每条在分册里）。

| 坑 | 一句话 |
|---|---|
| SW 打架 | 拆旧 SW 用 localStorage 标记锁成一次性，删缓存只认 `/^schedule-v\d+$/`（[踩坑 1](docs/踩坑.md)） |
| 拖拽排序 | 用「让位洞」不用插入线；位置取 dragstart 量的 `rawLayout`（[踩坑 6](docs/踩坑-前端-交互.md)） |
| 拖拽传感器 | 鼠标 `distance: 8`、触摸 `delay: 300 + tolerance: 8`；拖出容器用分身（[踩坑 51/54](docs/踩坑-前端-组件.md)） |
| 探针表达式 | `waitFor` 只吃表达式、`evalJs` 要自己 `return …;`（[踩坑 29](docs/踩坑-环境.md)） |
| 行尾 | 一律 LF，`.gitattributes` 的 `* text=auto eol=lf`（[踩坑 36](docs/踩坑-环境.md)） |
| 收尾 | 跑完 `pkill -x chrome` 归零、`ss -ltnp` 找残留服务 `kill`（[踩坑 40](docs/踩坑-环境.md)） |
| 共享盘 | 工程目录经 SMB 共享，偶发丢文件；别用 `perl -i` / `sed -i`（[踩坑 21](docs/踩坑-环境.md)） |
| 不猜日期 | 快速添加不解析文本，日期/时间只有「面板选的 > tab 默认值」（[踩坑 25](docs/踩坑-环境.md)） |
| CSS 层叠 | 同特异度后写赢；Tailwind 4 全在 `@layer` 里，无层作者样式永远赢（[踩坑 17](docs/踩坑-前端-交互.md)） |

---

## 五、给 AI 的硬约束

1. 后端只许引 AI 那一组依赖，其余 Node 标准库。pi 的 import 只许在 `server/lib/ai/`（现 8 个文件）。
2. 不引入 `v1` / `v2` 版本号并存 —— 结构变了就归档旧 key + 写迁移。
3. 不改 nginx 路径结构（没有 `/schedule2/`），回滚靠换线上目录内容。
4. 前端新依赖要先问。
5. `domain/` 保持纯净（无 React / DOM / 网络）。
6. 权限判断只在 `canWrite` / `canManage` / `db.roleOf()` 三个入口。
7. 别在文档里写密码。
8. 写完新组件顺手跑 `contrast.mjs` + `color-scan.mjs`；端到端交互无自动化覆盖，改完手工走一遍。
9. 发布走 `deploy/publish-*.sh`，不要手动覆盖线上目录。
10. 生产目录只由发布脚本写入，发布必须用户授权（默认 dry-run，只有 `--approve` 才动 `~/.local/schedule/`）。不要替用户加 `--approve`，也不要 `--allow-dirty` / `--allow-unpushed` 绕过体检。
11. 双端开发：Windows 在 `dev`，ubuntu 工程目录在 `main`，各推各的。合流由用户手动做，冲突时报告差异，不要替他选一边。尤其别动 ubuntu 那份工作区。
12. 工作区保护是铁律：动 git 前先看 `status` / `stash list` / `ls-files -u`；有别人的改动先存档，绝不覆盖。禁用 `checkout --` / `reset --hard` / `clean -fd` / `push -f` / `stash drop`。完整规则见 [docs/工作区保护.md](docs/工作区保护.md)。
13. 就地新建的落点由 `pointerdown` 快照决定（`app/src/app/tapSnap.ts`）。不要改回「click 时读 rect」。