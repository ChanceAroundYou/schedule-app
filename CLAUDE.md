# 日程清单

个人用的任务与打卡网页。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
**前后端分离**：React 前端 + 自写 Node 后端 + SQLite，数据在服务器上。

| 文件 | 读者 | 内容 |
|---|---|---|
| [README.md](README.md) | 人 | 网址、怎么用、数据在哪、日常命令 |
| `CLAUDE.md` | AI 编码助手 | **本文 —— 往哪走**：结构、数据模型、界面约定、硬约束 |
| [docs/踩坑.md](docs/踩坑.md) | AI 编码助手 | **改代码前先读 —— 别踩哪**：40 条坑，一条一条都是约束 |
| [docs/测试.md](docs/测试.md) | AI 编码助手 | 怎么验：跑哪些测试、每个探针节在验什么 |
| [DEPLOY.md](DEPLOY.md) | 人 + AI | nginx 怎么操作、conf 怎么写、发布流程、回滚 |
| [docs/接口.md](docs/接口.md) | 人 + AI | HTTP 接口一览 |
| [docs/重构路线.md](docs/重构路线.md) | 人 + AI | 2026-10-06 这次重写的决策记录 |

**改代码前先读 [docs/踩坑.md](docs/踩坑.md) 和「四、界面约定」** —— 那些约束都是踩坑换来的。
改 nginx 配置或发布流程前读 [DEPLOY.md](DEPLOY.md)。

> 本文里「**踩坑 N**」= [docs/踩坑.md](docs/踩坑.md) 的第 N 条。
> 本文只讲**为什么这么做、要往哪走**；「怎么验」在 [docs/测试.md](docs/测试.md)。

---

## 一、当前结构

```text
日程管理/
├── app/                    前端源码（= 部署产物的来源，有构建）
│   ├── index.html          Vite 入口，只有 <div id="root">
│   ├── vite.config.ts      base:'./'、build→../dist、dev/preview 代理 /api
│   ├── public/             icon.svg · manifest.json · sw.js（原样拷进 dist/）
│   ├── src/
│   │   ├── main.tsx        入口：**先拆旧版 Service Worker**，再挂载
│   │   ├── App.tsx         串起来的那层（约 840 行，见下）
│   │   ├── vite-env.d.ts   vite/client 的类型（import.meta.env 等）
│   │   ├── domain/         纯逻辑，零 React / DOM / 网络依赖
│   │   │   ├── types.ts    LocalState · Task · Habit · Op
│   │   │   ├── date.ts     today / addDays / weekStart / monthMatrix / fmt* / shortLoad
│   │   │   │                / parseDateText（「找日期」输入框专用，见踩坑 25 末）
│   │   │   ├── parse.ts    自然语言解析（规则顺序敏感，见踩坑 25）
│   │   │   ├── repeat.ts   重复推进 + seriesRootOf + 派生 id
│   │   │   ├── layout.ts   HOUR_H 等时间轴常量 + layoutOverlap
│   │   │   ├── model.ts    counts / liveTasks / dayLoad / 各种选择器
│   │   │   ├── merge.ts    逐字段 LWW 客户端侧合并 + findConflicts（冲突判定）
│   │   │   ├── ai.ts       AI：SSE 行解析 + 工具调用→人话 + 提案→人话（纯逻辑，见二、AI）
│   │   │   ├── ai.test.ts
│   │   │   ├── project.test.ts
│   │   │   └── domain.test.ts
│   │   ├── data/
│   │   │   ├── store.ts    localStorage 持久化 + 增删改查 + ui.* （K = schedule-app-v4）
│   │   │   ├── api.ts      fetch('./api/…') 封装、令牌、缓存的 user
│   │   │   ├── device.ts   设备标识（K = schedule-app-device）
│   │   │   ├── legacy.ts   读旧版 schedule-app-v1，只读不删
│   │   │   └── store.test.ts
│   │   ├── sync/engine.ts  outbox 推送 + 游标拉取 + 轮询调度 + 拖动守卫
│   │   ├── ui/
│   │   │   ├── Shell.tsx   侧栏 / 顶栏 / 底部标签栏 / 更多抽屉 / 快速添加 / 找日期 / 设置入口
│   │   │   ├── Calendars.tsx  日程集：侧栏切换条 · 管理浮层 · 邀请收件箱
│   │   │   ├── Drawer.tsx  抽屉（详情 + 编辑 + 「另一台设备也改过」那条提示）
│   │   │   ├── ActSheet.tsx  长按操作层（触屏专用，在「提起后原地松手」时出现，见踩坑 12）
│   │   │   ├── Settings.tsx  设置页：tab 布局（外观 · 安全 · 日程集 · 关于）
│   │   │   ├── Auth.tsx    登录 / 注册（开放注册，无管理员）
│   │   │   ├── AiPanel.tsx  AI 对话面板：气泡 + 动作条 + **提案卡片**（点确认才落库）
│   │   │   ├── AiSettings.tsx  Base URL / 模型 / key 的设置浮层
│   │   │   ├── AiHistory.tsx · AiMemory.tsx  AI 的操作历史与记忆库视图
│   │   │   ├── aiClient.ts  fetch + ReadableStream 读 SSE（带 Authorization）
│   │   │   ├── ProjectSheet.tsx  项目：建 / 改名 / 删 · 泳道看板
│   │   │   ├── kit.tsx     Btn · IconBtn · useConfirm · ConfirmProvider · ToastHost
│   │   │   ├── dnd.ts      **让位洞**拖拽层 + 触屏那条 pointer 通路（最易踩坑的一块，见踩坑 6 与踩坑 12）
│   │   │   ├── Clock.tsx   时间转盘：`ClockBody` 表盘本体 + `ClockPop`（抽屉里那个浮层）
│   │   │   ├── WhenPop.tsx  快速添加的日期 / 时间两层折叠面板 + 共享的 `MiniCalendar`
│   │   │   ├── dragState.ts  模块级「正在拖」标志，给 sync 守卫用
│   │   │   ├── hooks.ts    useStoreState / useScopedState / useIsNarrow / useOnline /
│   │   │   │                useOutsideClose / useKeyboardInset / useFocusTrap
│   │   │   ├── theme.ts    外观三轴（accent / style / theme）的选项表
│   │   │   └── cx.ts
│   │   ├── views/          纯展示，零回调，只出 data-* 属性
│   │   │   ├── Calendar.tsx  DayView · WeekView · MonthView · useViewLayout
│   │   │   ├── Lists.tsx     待办箱 · 今天 · 逾期 · 已完成
│   │   │   ├── Habits.tsx    打卡
│   │   │   ├── Projects.tsx  项目泳道看板（待办 / 进行中 / 已完成）
│   │   │   ├── Trash.tsx     垃圾箱
│   │   │   └── parts.tsx    行/方块等共享小组件
│   │   └── styles/
│   │       ├── legacy.css  旧版那 90 KB 设计系统，**不带 @layer**（见踩坑 17）
│   │       └── tailwind.css  样式入口 + 新表面的少量 CSS
│   └── tests/
│       ├── smoke.mjs          端到端冒烟（无头 Chromium + CDP，零 npm 依赖）
│       ├── browser-smoke.mjs  新界面照一遍：注册 → 切集 → 改名 → 接受邀请 → 触屏/鼠标拖拽 → 断网
│       ├── contrast.mjs       色板 82 对 ≥4.5:1 · 控件描边 8 对 ≥3:1 · 变量名写错 / 兜底值扫描
│       └── color-scan.mjs     写死的边框宽度 / --border-w 变量扫描
│
├── server/                 后端（Node 22，**只引 AI 那一组依赖**，见五、1）
│   ├── server.js           路由表 + 处理器 + 鉴权中间件
│   ├── lib/db.js           node:sqlite：建表 / field_state / changes / users / cals
│   ├── lib/auth.js         scrypt 哈希 + 自签 JWT + 用户名口令校验
│   ├── lib/sync.js         逐字段 LWW + 快照 + 全量游标增量 + 按集鉴权
│   ├── lib/calendars.js    日程集：建 / 改名 / 删 / 退出 + 成员与角色
│   ├── lib/invites.js      邀请：发出 → 待接受 → 接受 / 谢绝 / 撤回
│   ├── lib/ratelimit.js    定点窗口限速（登录 / 注册 / 邀请 / AI）
│   ├── lib/ai/             **AI 唯一能碰 pi 的地方**（见二、AI；依赖见五、1）
│   │   ├── index.js        惰性 import 的入口：依赖没装好也起得来
│   │   ├── chat.mjs        装配 pi 的 Agent + 事件→SSE 映射（pi 只在这儿）
│   │   ├── tools.mjs       工具定义：只读直接跑，写入**只造提案**
│   │   ├── confirm.js      提案落库点（CJS，不碰 pi）：重查权限 → applyOps
│   │   ├── prompt.mjs      系统提示词（今天是哪天 + 先提案后确认）
│   │   ├── settings.js     每人一行的模型配置，key 只进不出
│   │   ├── sessions.js     会话与消息的读写
│   │   ├── sse.mjs         SSE 写出
│   │   └── dates.mjs       服务器侧的几个日期小工具
│   └── tests/
│       ├── api.test.js        46 条接口用例
│       ├── migration.test.js  schema 迁移（**唯一会吃掉用户数据的代码**）
│       ├── ai.test.js         18 条 AI 层用例（假模型，不联网）
│       └── smoke-share.mjs    真走网络：两个人共用一个集的全流程
│
├── dist/                   构建产物（生成物，勿手改；nginx 只伺服这里）
├── deploy/                 nginx conf + systemd 单元的本地副本
├── legacy/                 旧版纯静态应用，**冻结**（回滚用，见 DEPLOY.md 七）
├── docs/                   接口.md · 重构路线.md · 踩坑.md · 测试.md
├── .gitattributes          行尾一律锁成 LF，压过各机器的 core.autocrlf（见踩坑 36）
├── package.json            只声明 AI 那一组依赖（见五、1），**没有 build 脚本**
└── README.md  CLAUDE.md  DEPLOY.md
```

**只有 `dist/` 会被 nginx 伺服**，源码 / `server/` / `legacy/` / 文档一律 404。

### `App.tsx` 里那几件事为什么都在一个文件

它是**唯一知道「全部状态」的地方**，所以这几样必须有全局视野的东西都放这儿：

1. **渲染调度**：`useStoreState()` 订阅 `store`，`renderAll` 对应一次重渲染。
2. **点击事件委托**：`#content` 上挂**一个** `onClick`，靠 `data-act` /
   `data-nav` / `data-jump` / `data-id` 分派。
   > **不是「懒得拆」，是必须这样。** 行是 React 渲染的，拖拽重排、同步落地
   > 都会把它们换掉，挂在行上的 handler 会跟着丢。容器级 handler 永远在。
   > 代价：`views/` 里全是纯展示组件，**零回调**。
3. **拖拽 / 拉伸**：`useDragLayer(containerRef)` + `.ev-resize` 的 mousedown。
4. **长按提起 + 触屏拖拽 / 长按操作层**（触屏）、**快捷键**、**导出 / 导入**。

### 三层状态，别混

| 层 | 在哪 | 谁是真相 |
|---|---|---|
| 领域模型 | `state.tasks` / `state.habits`（**按 id 索引的对象**，不是数组） | ← |
| 本地存储 | localStorage `schedule-app-v4` | 离线副本 |
| 服务端 | SQLite `~/.local/share/schedule/schedule.db` | **权威** |

> 排查「数据不对」**先看服务器**。浏览器那份只是副本。

---

## 二、业务模型（**最要紧的部分**）

### 工具分工：这是一个纯任务管理应用

用户既定：滴答清单位 = 有日期 / 要行动的任务；系统笔记 = 长篇幅记录；
系统备忘录负一屏 = 无任务属性的提示。**本项目不做长篇幅记录。**

备忘录 / 清单（lists）/ 笔记本（notebooks）三个模块已整体删除。

> **新版的迁移是「丢掉」，不是「归档」。** 旧版会把 `notes` + `notebooks` 折进一个
> `archive` 字段、转存到 `schedule-app-notes-archive` 再 `delete` 掉原键 ——
> **那是旧版行为，新版没有 `archive` 字段，也不写那个 key。**
> 现在 `domain/model.ts` 的 `migrateV3()` 只读 `raw.tasks` / `raw.habits`，
> 备忘录内容**直接不导入**（`legacy.ts` 里连「只剩备忘录」都会返回 null）。
>
> `ui.nav === 'notes'` 会被 `normalizeUi()` 兜回 `'today'` —— 旧版留下的
> 这个 nav 值不能让新版卡在一个不存在的页面上。
>
> **别再加回来。**

### 数据结构（前端 `LocalState`）

```ts
{
  tasks: { [id: string]: Task },     // 对象，不是数组
  habits: { [id: string]: Habit },
  cals: Cal[],                       // 我加入的日程集，服务器每次同步刷新
  invites: Invite[],                 // 待我处理的邀请
  ui: UiPrefs,                       // nav / view / cursor / theme / search /
                                     // navOrder / navBottom / tdoneOpen / cal
  cursor: number,                    // 已拉到的服务端序号（**全局**，见二、日程集）
  outbox: Op[],                      // 待推送的 op
  lastError: string | null,          // 上次同步的报错，顶栏下面那一条
  clockBlocked: string[],            // 被服务器退回但值得重试的 opId（时钟不对那一类）
  denied: number,                    // 被「没有写权限」挡下的改动次数，界面据此弹提示
  deniedCals: string[],              // 这一次被挡下的是哪几个集（提示要点名，见五）
  conflicts: FieldConflict[],        // 「同一字段两边都改过」的记录，给抽屉里那条提示用
                                     // （**故意落盘**：关掉之前一直在，见二、同步）
  syncing: boolean,                  // 瞬时状态，**不落盘**（load 时一律重置为 false）
}

interface Task {
  id,
  calId: string,               // **属于哪个日程集**。主键的一部分，不是可同步字段
  title, note,
  date: 'YYYY-MM-DD' | null,   // null = 待办箱（未定日期）
  time: 'HH:MM' | null,        // null = 未定时
  duration: number,            // 分钟，默认 60
  done, doneAt,
  repeat: { unit, n, weekdays, monthday, end },
  repeatSeq,                   // 已推进次数，用于 end.type='count'
  seriesId: string | null,     // 重复系列根 id（非重复任务是 null）
  order: number | null,        // 「同一天、未定时」这一组的位次
  ord?: number | null,         // 用户在列表里拖出来的顺序，**独立于 order**
  createdAt, source,
  deleted?: boolean,           // **墓碑**，不是物理删除
  deletedAt?, purged?: boolean,
  _ts?: { [field]: number },   // 每字段的 LWW 时间戳
  _dev?: { [field]: string },  // 每字段的最后修改设备
}
```

> **没有 `archive` 字段。** 旧版有个存旧备忘录的 `archive`，新版没有 ——
> 迁移时备忘录是**丢掉**的，不是归档的。见上面「工具分工」。

**任务与打卡是两个独立模块**，互不混入：任务走 `tasks`、打卡走 `habits`，
`habits` 的 `log` 是按日期的稀疏映射，没有 `date` / `time` / `duration` 字段。

**待办箱 = `date === null` 的未完成任务**（`counts().inbox`）。未定时是另一回事：
`date` 有、`time` 为空，落在时间轴上方的全天区。

**三态各自独立**：未定时任务（`time===null`）· 未定日期任务（`date===null`）·
已完成但仍占时间段（`done && time`，灰显留在时间轴上）。
只有第二态进待办箱。

**删除是墓碑**：`deleted = true` 让别的设备知道「要删」。
`purged = true` 才在任何地方都看不见（垃圾箱里也没有）。
`liveTasks()` 过滤掉两种，`trashedTasks()` 只要 `deleted && !purged`。

### 日程集、成员与权限（2026-10-06 加的）

**没有管理员，所有人平等，注册开放。** 用户之间共享内容的方式是**日程集**
（`calendars` / `calendar_members`），像相册：一个人可以同时在好几个集里，
在每个集里的角色可以不同。

> 共享的**单位是集，不是任务**。没有「把这一条任务分享给某人」这回事 ——
> 想单独分享就新建一个集。这条约束让整个权限模型只需要在一个地方判断。

**三档角色**（`Role`）：

| 角色 | 能改任务 / 打卡 | 能改集与成员 |
|---|---|---|
| `owner` 创建者 | ✅ | ✅ |
| `editor` 可编辑 | ✅ | ❌ |
| `viewer` 只读 | ❌ | ❌ |

> **权限判断只有两个入口**：`canWrite(role)` / `canManage(role)`（`domain/types.ts`）。
> 别在别处写 `role === 'owner'` —— 加一档角色时那些散落的比较一定会漏。
> 服务端同理，只走 `db.roleOf()` / `calendars.canWrite()`。

**三条不变量**，改这块代码时不能破：

1. **每个人永远至少有一个集**（`calendars.ensureHasCalendar`）—— 注册时自动建
   「我的日程」。一个集都没有的账号在界面上是死路。
2. **每个集永远至少有一个 owner** —— 最后一个 owner 不能被降级、不能被移出、
   退不出去。否则那个集就成了没人能管的孤儿。
3. **写权限在写入通道那一层把关，不是靠界面把按钮藏起来。**
   前端的 `store.commitMany()` 和后端的 `sync.applyOps()` 各挡一次；
   界面上漏了一个入口，那两处还能兜住。

**`calId` 是主键的一部分，不是可同步字段**（和 `_ts` / `_dev` 一样只存在本地）。
所以**把任务从一个集挪到另一个集 = 在目标集新建一条 + 在源集留一个墓碑**
（`store.moveToCal()`），而不是改一个字段。

**邀请是两段式的**，对方**接受后才生效**：`pending → accepted | declined | revoked`。
发邀请时按用户名找目标（找不到就 404，别提示「这个名字存在吗」），
不能邀请自己，已经在集里的人不能再邀请。同一个「集 + 人」只会有一条 pending。

### 同步：一个全局游标，不是每个集一个

`changes.seq` 是**全局单调**的自增主键，客户端只存一个 `cursor`。
拉的时候服务端按 `cal_id IN (我的集)` 过滤。

这样省掉了「每个集各自一个游标」的那张表，代价是一个必须处理的坑：

> **新加入一个集时，那个集的historical 变更全在游标后面。** 游标表达的是
> 「我已经看到全世界第几号了」，加入之前那个集的历史你早就跳过去了，
> 光靠增量**永远拉不到**它的内容。
> 所以客户端一旦在响应里看到自己不认识的 `calId`，就**再要一次全量快照**
> （`sync/engine.ts` 的 `syncNow()` 里那段 `known` 判断）。
> 加集 / 接受邀请之后也会主动 `refreshMeta()` + `syncNow()`。

`POST /api/sync` **一次调用同时推和拉**，而且服务端**先落盘再取数** ——
返回的快照已经含本批 op 合并后的结果。分成两次请求会拿到一个慢半拍的快照，
客户端再合并回来就把自己的写入盖掉了。

**日程集 / 成员 / 邀请走普通 REST，不走 LWW 同步引擎。** 它们是「关系」不是
「字段」，用时间戳定胜负没有意义 —— 一个集该不该存在、谁是什么角色，
只能是服务端说了算。

**「同一字段两边都改过」要在界面上说一句**（2026-10-06 加的）：

- 判定：`domain/merge.ts` 的 `findConflicts(pushed, changes, myDeviceId)` —— 纯函数，
  输入是**这一轮推上去的 op** 和**同一轮拉回来的变更**，输出每字段一条
  `{ field, winner, mine, theirs }`。只有「我推的字段」和「别人的改动」撞上才算，
  `winner` 由和 SQL 里完全相同的那套 `(ts, deviceId)` 比较得出。
- 只有**增量**那一路会记（`res.changes`）。快照是「我刚进这个集，把历史整份拉下来」
  （见上面那个坑），拿它判必然误报成一片 —— 这也是为什么这一节要放在这儿：
  两者的区别只有懂上面那段的人看得出来。
- 记录落 `store.addConflicts()`（同一 `(实体, 字段)` 顶掉旧的，上限 50 条），
  **落盘**：用户点了「知道了」之前它一直在，刷新不该又冒出来。
- 抽屉里那条提示显示的是**输的那一方**的值 —— 赢的那版就在上面几个输入框里。
  配色走 `--warn`，**不做成报错红**：数据是好的，只是有一边的改动不在了。

### AI：它是「另一台设备」，不是一条新通道（2026-10-06 加的）

应用内一个对话面板，模型自己去查排期再回答，并且**能提出改动** —— 但改动要用户
点确认才落库。

**核心判断：AI 读走 `sync.snapshot(userId)`，写走 `sync.applyOps(userId, ops)`，
`deviceId` 固定 `'ai'`。** 三个复用，每个都对应上面一条明文约束：

| 复用 | 为什么不能另起一套 |
|---|---|
| 读 `sync.snapshot()` | 它已经按 `calendarIdsFor(userId)` 过滤、已经剔掉墓碑。自己写 SQL 读 `field_state`，权限过滤迟早漏一处 |
| 写 `sync.applyOps()` | `calendars.canWrite(db.roleOf(...))` 在**这个函数里**，是全项目唯一的服务端权限把关点。AI 绕过去 = 只读成员能被 AI 写穿 |
| 落到界面 `engine.syncNow()` | AI 的 op 会写进 `changes` 并带一个新 `seq`，客户端本来就会拉到，不用给 AI 单做推送通道 |

于是 AI 会**自然地**出现在两处已有机制里，而且都是对的：客户端拉到的改动
`_dev` 里是 `'ai'`；用户同一轮手改了同一字段时，`findConflicts` 会把 AI 当
「另一台设备」报冲突 —— **这是诚实的，不要特判掉**（确实有另一个写入者）。

**写路径：工具、提案、确认，三段。** 这是这个功能里最要紧的一条：

1. **写工具（`create_task` 等五个）的 `execute` 正常返回，但只造提案、不落库。**
   `tools.mjs` 里存进 `Map<toolCallId, proposal>`，返回一个成功结果。
   > **不用 pi 的 `beforeToolCall` 拦。** 计划里原本写的是那个闸门，实现时改了：
   > `block` 会产生一个**错误工具结果**，模型会以为工具坏了、换个说法反复重试。
   > 真正的强制是**结构性**的 —— 写工具根本没有写的能力。
2. 提案按 **`toolCallId`** 关联到 assistant 消息（**不按执行顺序**：pi 默认并行
   执行同一轮的工具，`tool_execution_end` 回来的顺序和消息里 toolCall 块的顺序
   可以不一样），存进 `ai_messages.proposals`，所以刷新后卡片还在。
3. `POST /api/ai/confirm` 是**唯一真正落库的地方**（`lib/ai/confirm.js`）。
   它**只信 id 不信参数**：按 id 从库里读回提案，**重查一遍权限**
   （生成到确认之间用户可能被降级 / 被移出），再走 `sync.applyOps`。
   信客户端回传的 args 等于把权限判断交给浏览器。

**提案里存的是 `fields`（最终要落进 op 的字段），不是「意图」。** 所以确认那一步
完全不认识 `kind`、不需要知道任何工具语义。界面同理：`proposalText(p)` 读 `fields`
就能把「打算改什么」说清楚。

**几个具体约定**：

- 确认时的时间戳走 `confirm.js` 的 `nextTs()`（`max(Date.now(), lastTs+1)`）——
  同一毫秒的两条 op 比较键完全相同，后一条会白写。起点仍是 `Date.now()`，
  因为 `validateOp` 会拒掉与服务器时间差 24h 以上的 op。
- 重复任务**拒绝**标完成（`tools.mjs` 里 `fail`）：推进逻辑在客户端的
  `repeatAdvance()` 里，服务端不复制一份。
- 软删除带 `trashFrom: 'AI'`，垃圾箱那行看得出是 AI 干的。
- `lib/ai/confirm.js` 是**CJS、直接 require**，不走 `ai/index.js` 那条惰性 import：
  确认是纯数据库操作，一条都不碰 pi。依赖没装好时，用户最需要的恰恰是把已经
  排好的改动确认掉。
- 界面上的动作条文案（「正在查 10月7日的安排」）**写死在 `domain/ai.ts` 里**，
  不让模型自己说 —— 那是给用户看的确定性提示，而模型在同一轮里还没开始说话。

**密钥**：Base URL / 模型 / API key 由用户在设置浮层里填，存服务器
`ai_settings`，**只回 `hasKey: true/false`，绝不回显**。`PUT` 时 `apiKey`
字段省略 = 保留原值、传空串 = 清空 —— 这个三态必须保住，否则一打开一保存就把
key 抹了。key 是明文落在 `schedule.db` 里的，与 `secret.key` 同一级信任
（靠数据目录的 nginx 404 + 文件权限隔离）。

**没有 seed、也没有「演示模型」。** 模型来源是本机或用户自填的 OpenAI 兼容端点。

### 重复规则

`repeat` 对象化（2026-10-05 升级，旧数据里的字符串 `'weekly'` 由 `U.toRepeat` 转换）：

```js
{ unit: 'none'|'day'|'week'|'month'|'year', n: 1,
  weekdays: [],          // unit='week' 时生效，空 = 沿用原日期的星期
  monthday: 原日期的日号, // unit='month' 时生效（31 号在 2 月会被截到月末）
  end: null | { type:'date', date } | { type:'count', count } }
```

推进逻辑在 `domain/repeat.ts` 的 `repeatNext()` / `repeatAdvance()`：
**勾选完成时若下次发生日在今天之前，会一路补到今天之后**，并在 `repeat.end`
允许时新建一个实例（`repeatSeq + 1`）。

> **防死循环的判据是「必须往前走」，不是一个次数上限。**
> 曾经写的是 `guard < 800`，**那个上限被证明是错的**：一条 2020 年起的「每天」
> 任务需要 2400+ 步才能补到今天，800 步就断了，返回一个 2022 年的日期 ——
> 于是每勾一次完成就凭空造出一个过去的实例，**正是它本来要防的那个 bug**。
> 现在的循环条件是 `while (next && next < today && next > cursor)`：
> `next > cursor` 既能防「规则原地踏步」（坏数据），又不会在大跨度上误伤。
> **别再把它换回一个魔法数字。**

> **`repeat.monthday` 与 `task.date` 要分开看。** 每月 31 号的任务在 2 月
> 会被 `repeatAdvance` 截到月末（`Math.min(day, last)`），但 `task.date` 仍是 31 号。
> 改重复规则时别用 `task.date` 反推 `monthday`。

**重复实例的 id 是派生的**：`seriesRootOf(task)` 给出系列根，实例 id 是
`instanceId(根, 发生日)` = `` `${根}#${发生日}` ``。
两台设备离线各自推进同一系列，会**派生出同一个 id**，同步时合并成一条而不是翻倍。
这是整个同步模型里最要紧的一条不变量，`domain/domain.test.ts` 有专门用例。

### 逾期

`counts().overdue` 是**唯一口径**：`!done && date && date < today`。
`counts().today` 只算当天，**不包含逾期** —— 2026-10-05 明确拆开，
之前混在一起导致同一任务在两个徽标里各数一次。

逾期页按原定日期分组，组标题写「逾期 N 天」，每行带 今天 / 明天 / 改到… 三个快捷改期。
「改到…」用离屏 `<input type="date">` + `showPicker()`，不走完整抽屉
（`App.tsx` 的 `pickDate`，元素用 `setTimeout(remove, 60000)` 兜底清理）。

### 侧栏「今日进度」的口径与别的徽标**故意不同**

`Pulse` 组件（`ui/Shell.tsx`）的分母是「今天排了的事」**全部（含已完成）**，
分子是其中做完的 —— 才是进度条。`counts().today` 是「今天还没做的」，
拿它当分子会算出永远 0% 的进度条。窄屏的「更多」抽屉里渲染的是**同一个组件**。

### 首次打开的演示数据

**新版没有 seed。** 旧版 `store.js` 的 `DB.seed()` 会生成 7 条任务 + 3 个打卡，
那是**旧版行为**。用户报「怎么有别人的任务」时：
先怀疑 Service Worker 发了一份旧版页面（见踩坑 1），不是数据污染。

---

## 三、本地开发

### 前端

```bash
cd app
npm run dev          # Vite :5199，/api 自动代理到 127.0.0.1:25692
```

改完要构建才影响线上：

```bash
cd app && npm run build          # tsc -b && vite build → ../dist/
```

> `npm run dev` / `npm run preview` **都占 5199**，别同时开。
> `preview` 用的是 `vite.config.ts` 里**另一段** `preview.proxy` 配置 ——
> 只写 `server.proxy` 的话，预览里所有 `/api` 都 404，看起来像「登录不上」。

### 后端

```bash
node server/server.js                        # 127.0.0.1:25692，数据落 server/data/
SCHEDULE_DATA_DIR=/tmp/x node server/server.js   # 换数据目录（跑测试时用）

# 依赖装在**本机磁盘**上，不在共享盘（CIFS 上成千上万个小文件正是踩坑 21
# 那个丢文件风险）。靠工程根目录一个软链接指过去：
ls -la node_modules
#   node_modules -> /home/xiaokubao/.local/share/schedule-deps/node_modules
#
# 换台机器 / 新拉一份 checkout，都要补这个链接（否则 AI 页报「依赖没装好」）：
ln -s /home/xiaokubao/.local/share/schedule-deps/node_modules ./node_modules
```

> **软链，不是 `NODE_PATH`。** 两种都行，实际用的是软链 —— 因为它**不需要**
> systemd 那条 Environment，也不挑进程是从哪个目录起的。`node_modules` 在
> `.gitignore` 里，所以链接不会进版本库，**每份 checkout 都得自己补一次**。

> **`node server/server.js` 从此不再自包含。** AI 那组依赖（见五、1）没装的时候，
> `server/lib/ai/index.js` 是**惰性 import**，所以服务照常起得来 —— 只是 AI 页
> 会报「依赖没装好」。确认提案那条路（`ai/confirm.js`）走 CJS 直接 require、
> 一条都不碰 pi，所以**依赖没装好也能把已经排好的改动确认掉**。
> 装法见 [DEPLOY.md](DEPLOY.md) 的「依赖」一节。

线上那份由 `systemctl --user` 管，见 [DEPLOY.md](DEPLOY.md) 2.4。

---

## 四、界面约定

**交互统一是「列表 → 详情 → 编辑」三段式**（用户 2026-10-05 裁决）。
任务一律走这条路：点行 → `drawer` 详情 → 从抽屉底部进编辑。

删除走应用内确认弹层（`useConfirm`），正文要写清连带后果。

**界面上不要出现「备忘录」「笔记本」「清单」的字样。** 三个模块已删除，
旧数据里的备忘录内容迁移时**直接被丢掉**（没有 `archive` 字段，见二）。

**脚本身份统一是「打卡」不是「习惯」。** `habits` 数组名保留（数据结构），
界面文案一律「打卡」，侧栏 `data-nav="habits"` 的 label 写「打卡」。

**深浅色只有 light / dark 两档**，存 `ui.theme`，设置页切换。
**风格有三档**（soft / flat / notion），存 `ui.style`，靠 `documentElement` 上的
`data-style` + `legacy.css` 令牌块。**色板没有** —— 那是账本项目的机制，别照抄。

**灰阶的取值是算出来的，不是挑出来的。** `--text` / `--text-2` / `--text-3`
三档，每一档对**每一种底色**（亮色最难的是 `--panel-3` `#f3f5fa`）都要 ≥ 4.5:1
（WCAG 1.4.3 正文）。这三档不是装饰色：`--text-2` / `--text-3` 在 10.5–12px 的
**有信息量**文字上用了 38 处（时间轴刻度、行内元信息、打卡连续天数…）。

> 旧值 `--text-3: #949bab` 只有 **2.79:1**，看着「淡雅」，实际读不清。
> 修的时候**必须按 L\* 感知亮度定档，不能按对比度比值** —— 比值不是线性感知，
> 按比值补到 4.5:1 会正好落在 `--text-2` 上，**三层灰当场塌成两层**。
> 现在的做法是把三档的 L\* 间距按原比例整体压进达标区间。
> `app/tests/contrast.mjs` 锁着这条（`node tests/contrast.mjs`，零依赖）。

**语义色（`--primary` / `--danger` / `--warn` / `--ok`）与「快速添加」那组胶囊
同样是按对比度算的**，理由一样：它们承载的全是正文 —— 错误提示、危险按钮、
打卡连续天数、进度数字、解析预览。**亮色那一套原先整体只有 2.66–4.39**
（`--warn` 2.66 最糟，`--ok` 3.46，三个胶囊 3.88–4.22），已经全部提到 4.5:1 以上。
**暗色那一套的语义色本身达标**，但「压在它上面的白字」不达标 —— 见下面
`--on-primary` 那一段。

> 语义色比灰阶**多一层约束**：`--primary` / `--danger` **既当文字色、也当底色配字**
> （`.check-btn.on` / `.chip.active` / `.nav-item .count.warn` / `.btn-primary`…）。
> 所以每个都要同时满足「对自己的 soft 底」和「`--on-primary` 对自己」，**只往一个方向调
> 会让另一种用法更糟**。`contrast.mjs` 把这两个方向都断言了。
>
> `--warn` 是唯一视觉上明显变了的（橙 → 褐，`#e08b25` → `#a16217`）：
> 2.66 实在太低，不压到这个深度绕不过去。
>
> **13 处光晕原先是写死的 `rgba(74,108,247,…)` / `rgba(223,74,79,…)`** ——
> 旧 `--primary` (`#4a6cf7`) / `--danger` (`#df4a4f`) 的副本，而这两个颜色现在
> 全站哪里都没有了。已改成 `color-mix(in srgb, var(--primary) N%, transparent)`：
> 位移 / 模糊 / 扩散一个字节没动，只有颜色回到当前主题的语义色上，α 原样保留。
> 暗色下从「一层发灰的旧蓝」变成跟着 `--primary` 走的亮蓝。
> （`color-mix` 抗得住压缩 —— 构建产物里 13 处都在；另外 19 处是 Tailwind
> 自己给 `bg-white/10` 那类透明度修饰符生成的，说明这个构建目标本来就用它。）

**`--on-primary`：压在语义色上的文字色，亮色 `#fff`、暗色 `#101216`。**
19 处 `color: #fff` 落在 `--primary` / `--danger` 底上的，一律走 `var(--on-primary)`。

> **为什么暗色必须反过来。** 暗色的 `--primary` (`#6d8bff`) 是个**亮蓝**，白字压上去
> 只有 **3.09**；`--danger` (`#f0656a`) 同理 3.10。**这不是没调好，是单色无解** ——
> 枚举过整个色相不变的范围：让 `--primary` 既要在 `#181b22` 上读得清（要够亮）
> 又扛得住 `#fff` 压上来（要够暗），满足两个条件的取值有 **0 个**。
> 暗色改用近黑字之后是 **6.1:1**，亮色本来就够深、白字 5.11 —— 两套都过。
>
> **两处故意留 `#fff`，改之前先看理由**：`.brand-logo` 是 32×32 的图标字，
> WCAG 1.4.3 明文豁免 logotype（而且它的渐变第二站 `#7b53d8` 偏深，换深色字
> 反而掉到 3.66）；`.toast` 的底是写死的深色（两套主题都深），换深色字会看不见。
>
> 这两条都在 `legacy.css` 里各留了就地注释，别当成漏改。

### 顶栏一行 + 日程副header（2026-10-07）

用户报的是「移动端 header 挤成好几行、暗色按钮多余、搜索框到处都是」，
日程页还要「整体重新设计简化」。落成了三件事：

**1. 顶栏（`.topbar`）在所有端都是一行** —— 标题 + 搜索 + 同步状态。
窄屏原先被 `legacy.css` 改成 `flex-direction: column`，而第二行里的
`date-nav` 自己还会 `flex-wrap`，实际是**三行**。现在统一 `row`。
顶栏**照旧不许加 `position` / `z-index` / `sticky`**（见踩坑 11）。

**2. 日程页的控件搬进副header**（`ui/Shell.tsx` 的 `CalSubheader`）：
`‹ › / 今 / 找日期` + `日|周|月`，只在 `nav === 'calendar'` 时渲染，
紧贴顶栏下面一行（`.cal-subhead`）。**副header 只放控件，一个日期字都不写。**

> **日期长文本归顶栏**（就在副header 的上一行）。原先两处都写一遍，于是桌面
> 日程页「2026年10月7日 周三」在相邻两行各报一次，读的人不知道该看哪行。
> 现在粒度跟着视图走：**日 = 某天（`10月7日`）· 周 = 这一周的起止
> （`10月5日 – 10月11日`）· 月 = 年月（`2026年10月`）**。
> 周视图原先跟月视图一样写「2026年10月」，看不出「这一周是哪一周」。
> `browser-smoke.mjs` 第十七节数着 `.cal-subhead .date-range` 的个数（应当 == 0），
> 再按视图分别断言顶栏标题的格式。
>
> 三个控件各自的简化：
>
> - **「今天」按钮只留一个「今」字。** 在不在今天**不靠文字**，靠 `.away` 那一档
>   配色（`--primary` 字 + `--primary-pale` 底 + 描边 + 加粗）—— 见 `.today-btn`。
> - **「找日期」只留图标**（`.jump-btn` 里的 lucide），没有文字。
> - **上一 / 下一个是 `.round-btn`**：30px 见方、`display: flex` 居中。
>   里面只有一个图标，靠 `line-height: 1` 加内联 SVG 会偏 1~2px，看着就是
>   「没居中」。**功能跟着视图走**（`App.tsx` 的 `shift()`）：日 = ±1 天、
>   周 = ±1 周、月 = ±1 月 —— 这一段是既有的，探针补上了断言。

**3. 搜索框窄屏收成一个图标 + 点开的浮条**（`SearchPop`），宽屏仍是常驻输入框。
两者共用 `SearchInput` 与 `useSearchValue`（180ms 防抖）；浮条照抄 `JumpPop`
的 `position: relative` 包裹 + `useOutsideClose` 那一套，不引新机制。
**主题按钮不在顶栏**，入口只有设置页的外观卡（`.topbar` 里连 `onTheme` 都没有）。

两条接线上的坑，都锁在 `browser-smoke.mjs` 第十七节：

- **`onSearch` 必须是 `useCallback`。** `useSearchValue` 的 effect 依赖里有它，
  传内联箭头（每次渲染换一个身份）会让那个 effect 每渲染跑一遍。
- **Esc 那个键盘 effect 的依赖数组别漏项。** `searchOpen` 漏过一次，症状是
  「浮条开着按 Esc 关不掉」—— 闭包里读到的值永远停在挂载那一刻，而开浮条
  不会改动数组里其余任何一项，effect 根本不重跑。探针验过它有牙：
  把 `searchOpen` 摘掉重跑，会**中断在「Esc 关掉了搜索浮条」那一步**。

> **「视图切换选中态没有提示」是个真 bug，不是没设计。** 按钮的类名是 `.on`
> （`Shell.tsx`），CSS 规则却写的是 `.view-switch button.active` —— 两者不匹配，
> 选中态样式**从未生效过**。现在 `legacy.css` 两处都改成了 `.on`
> （`:hover` 那条也要跟着改，否则按下时高亮会消失）。
> 这是「类名与选择器对不上」的典型：**改类名时全仓搜一遍**，别只改写的那一处。

**副header 四个控件同高、同字号、同圆角、同描边**（`.round-btn` / `.text-btn` /
`.view-switch button`）。它们并排站在一行里，任何一个高一点或字大一点，
整行看着就是歪的。**高度写死，不用 padding 推** —— 12.5px 的
`line-height: normal` 各浏览器差 1~2px，光靠 padding 永远对不齐；里面只有一个
图标或一个字，所以用 flex 居中（靠 `line-height: 1` 加内联 SVG 会偏 1~2px）。
宽屏 30px，窄屏 34px（触控目标）。日周月是**分段控件**（一个圆角框里三格），
描边由容器提供，格子用右边框分段 —— 但高度 / 字号 / 圆角 / 字色与旁边三个
独立按钮一致，否则并排看着就是两套。

### 周视图窄屏横滑 + 吸顶行背景 + 表头简化（2026-10-07）

**窄屏下 7 列要横滑**（`.week-view` 在 ≤900px 时 `overflow-x: auto`，列宽锁死
`minmax(92px, 1fr)` + `min-width: 644px`）。一屏只看得见 3 天，所以
`views/Calendar.tsx` 的 `centerWeekDay()` 把「今天 / 选中的那天」摆到可视区
中间 —— 不定位的话用户根本不知道左右还有。

> **周一和周日居中不了**（一边没有列），算出来的 `scrollLeft` 会越界，
> `Math.min(want, scrollWidth - clientWidth)` clamp 之后自然贴边，
> 所以不需要特判。判据是「左右各有足够的列」，不是「离中间最近」。
> `useViewLayout` 的 week 分支在 `g.scrollWidth > g.clientWidth + 1` 时才调
> `centerWeekDay` —— 宽屏不横滑，调了也是白调。

**吸顶的表头与未定时行，背景必须盖住整条滚动宽度。** 这两行是 `.week-view`
（`display: flex; flex-direction: column`）的 flex 项，作为 flex 项时只有容器那么宽
（≈一屏 526px），而它们内部的列网格 `min-width: 644px` —— 于是右边三四列的
头部透出下面时间网格的刻度线，看着就是「表头只画了一半」。修法是
`width: max-content`（列宽有 `min-width` 兜底，不会缩没）。
**未定时行同理**，而且它**上下都要有分割线**：只有下面那条时，这一行和上面的
周几表头融成一体，看不出「未定时」是独立的一块。

**表头不再有负载横条与任务计数**（`.wh-load` / `.wh-count` 已删），
**今天的数字也不再加圆形底色** —— 那一格会凭空高出 9px，同一行里其他日期的
数字看着就是没对齐。「今天是哪天」由下面 `.week-col.today` 的 `--primary-pale`
整列淡底负责，表头不重复做，只把数字染成 `--primary`。

锁在 `browser-smoke.mjs` **第二十一节**（跑在**宽屏**下）：四档控件同高 30px、
`.wh-load` / `.wh-count` 计数为 0、未定时行上边框 ≥ 1px、今天的数字没有圆底。

> **窄屏那几条（34px 按钮、7 列横滑、表头 `width:max-content`、`centerWeekDay`
> 居中）探针测不了。** 探针的伪窄屏只在 JS `matchMedia` 上套了 Proxy，CSS
> `@media (max-width: 900px)` 不认这个 —— 窗口真的 1280px，媒体查询就是不匹配。
> `Emulation.setDeviceMetricsOverride` 能把视口改窄，但改完之后合成事件不进处理器
> （见踩坑 24），没法点进周视图。**这几条只能靠真机 / 真浏览器看。**

### 快速添加：窄屏一个圆钮 `+` / `×`，日期 / 时间分两层（2026-10-07）

**窄屏（≤900px）默认收起成右下角一个圆钮，点开才展开横条、再点原地收起。**
宽屏常驻展开 —— 桌面有地方，多一次点击只是碍事。状态是 `QuickAdd` 里的
`expanded = useState(!narrow)`，**不落盘**：这是「这一次怎么用」，不是用户偏好。
`narrow` 用 `useIsNarrow()` 同步初始化，所以首帧就是对的，不会闪一下。

**那个圆钮是一直在的**（收起 `+` / 展开 `×`），**不是「展开就消失、收起键搬进横条」**。
横条就是从它这儿弹出去的，所以它不能跟着横条一起 `display:none` ——
那样就没有「弹出来」可言了。三个几何量互相咬合，改一个要一起看：

| 量 | 值 | 为什么 |
|---|---|---|
| 横条 `left` | `13px` | 和宽屏那条基线左右对齐 |
| 横条 `right` | `74px` | `16 + 48 + 10` = 圆钮的右偏移 + 直径 + 缝 |
| 横条 `bottom` | `calc(64px + env(safe-area-inset-bottom, 0px))` | 64 = 标签栏 56 + 8px 缝 |
| 圆钮 `bottom` | `calc(fabBottom px + env(…))` | 见下 |

- **圆钮和横条竖直居中**：`fabBottom = max(58, 64 - 24 + barH/2)`。
  横条被输入框撑成两行时圆心跟着往下走，所以它是按横条的**实测高度**反推的，
  不是写死的。58 是下限（再低就压到标签栏上）。
- **这些几何量写在 `Shell.tsx` 的内联 `style` 里，不只是 CSS 媒体块里。**
  媒体查询按**真实**视口宽度走，而探针是「JS 判窄、CSS 判宽」的环境
  （见踩坑 24），只写媒体块的话那边量不到。`margin: 0` 也必须写在内联里 ——
  `position: fixed` + `left/right` 的定位里 `margin` 会**再加一层**偏移
  （`right: 74px` 实际让出 96px，见踩坑 38）。
- **弹出动画**：`@keyframes fastPop` 挂在 `.fast-add:not([hidden])` 上，
  配合内联的 `transform-origin: 100% 50%`（= 圆钮的左边缘）。
  挂 `:not([hidden])` 是因为 `display:none` 会把动画移除、再显示时重新开始。
- `.fast-fab` 的 `z-index` 是 **39**：要压住正文，但**必须低于抽屉遮罩的 40** ——
  抽屉打开时它该被罩住，而不是浮在遮罩上还能点。
- **输入框是 `<textarea rows={1}>`，默认一行、内容多了自己撑开。**
  撑开靠 `useLayoutEffect` 里「先把 `height` 归零、再读 `scrollHeight`」——
  **不归零的话它只会越长越高**，删掉一行也缩不回去（`scrollHeight` 里含当前 height）。
  回车仍然是保存，换行让给 `Shift + Enter`。
- **「保存」是个 ✓ 图标，摆在日期按钮前面**，两者都是 `30px` 高。
  日期按钮里要摆**两行 10px 的小字**，两行加行距约 22px ——
  **高度不能跟着内容变**，否则「只有日期」和「日期 + 时间」两种状态横条会跳一下。
- 「N」快捷键在窄屏下**先展开再聚焦**。收起的横条是 `display:none`，聚焦不上去，
  所以展开后要等一次 effect（`focusOnExpand` ref）再 `focus()`。
- 收起的横条靠 `hidden` 属性藏（Tailwind 4 preflight 的
  `[hidden] { display: none !important }` 压得住 `legacy.css` 里没分层的
  `.fast-add { display: flex }`）。**别改成自己加一个 `display:none` 的类** ——
  那就得跟层叠顺序再斗一次（见踩坑 17）。

**点空白收起是「两级」，而且两级在同一个 handler 里**（`Shell.tsx` 的 `QuickAdd`）：
面板开着 → 先收面板、横条留着；面板没开 → 才收横条。宽屏没有「收横条」这一级
（`if (narrow)`），横条是常驻的。

> **不能两处各挂一个 `document` 上的 capture 监听。** 面板（`.when-pop`）是横条的
> **DOM 子节点**，而它的定位是 `position: fixed` —— 几何上离得很远，DOM 上却是一家人。
> 「点在面板里」在两边的 `contains()` 判断里都成立，谁先跑只看注册顺序，
> 必然有一边误判（先收横条的话，用户点空白想收面板，整个输入框也没了）。
> 所以 `WhenPop` 里**只剩 Escape**，外面的点击整件事收在 `QuickAdd`。
> `barRef` / `fabRef` 的 `contains()` 放行，其余交给各自的 `onClick`。

**日期 / 时间那块是一个两层折叠面板（`ui/WhenPop.tsx`），不是两个浮层。**
上面一层日期、下面一层时间，各点各的标题行开合，**同时只开一层**。

- **每行是三个平级的 `<button>`**：`.wp-head`（开合）+ `.wp-act`（清空 / 跳过）+
  `.wp-cv`（箭头，也是开合）。**不能嵌套** —— 嵌套 button 是非法 HTML，
  浏览器会把里层那个甩到外面去；换成 button 里塞 `role="button"` 的 span
  也一样是嵌套交互元素，读屏会当成两个控件来回问。
- **「清空 / 跳过」在箭头左边**，`.wp-head` 仍然是 `flex: 1` 吃掉剩下的宽度。
- **面板底部没有出口按钮。** 那个「收起」删掉了 —— 点面板外面就收（见上）。
- **打开时先开哪层看「有没有日期」**：没有（待办箱）先开日期层；已经有
  —— **包括跟着 tab 来的默认值**（今天页 = 今天、日程页 = 光标那天）——
  先开时间层。判据是 `effDate`，不是 `pendingDate`。
- **点中某天 → 自动收起日期层、切到时间层。** 挑完日期下一步几乎总是挑时间。
- **「不设置」拆成两个，贴在各自那行上**，文案跟着状态走：有值写「清空」、
  没值写「跳过」（`actOf`）。不是「取消」：取消是「我刚才白点了」，
  不设置是「这一条就是没有日期也没有时间」。在待办箱里后者是常态，
  在「今天」页上它更是唯一能把默认的今天摘掉的路。
- **`pendingDate` / `pendingTime` 是三态**：`undefined`（没表过态 → 用默认）、
  `null`（明确说不要）、`'…'`（选了这个）。**混成两态的话「清空」会被
  tab 默认值顶回来**，点了跟没点一样 —— 和 `navBottom` 是同一类坑（见踩坑 16）。
- **按钮上那两行写的是生效值**（`10/7` + `08:00`，`D.fmtSlashMD`），
  跟面板里写的是同一个 `effDate` / `effTime`。**别一个写 `pending*`、
  一个写 `eff*`** —— 那会出现「按钮写 10/7、面板高亮别的日子」。
- 生效值优先级：**面板选的 > 文本解析 > tab 默认**，日期与时间都是。
  （时间这一项曾经是 `parsed.time ?? pendingTime`，漏了「面板优先」。）
- **不做「最近用过的日期」快捷推荐**：面板里再塞一行 chips 就放不下了，
  而且这是个日程管理软件 —— 日期是**选出来**的，不是**猜出来**的。

**转盘拆成了两半（`ui/Clock.tsx`）：`ClockBody` 是本体，`ClockPop` 是抽屉里那个浮层。**

- 表盘本体**只有一份**，两处共用。`ClockPop` 只是给它套上定位 + 「确定 / 取消」。
- **两条路的出口语义相反**：快速添加是实时的（拨一下立刻回传，没有「确定」），
  抽屉是「取消 = 反悔」（先攒在 draft 里，点确定才交出去）。别统一。
- 表盘直径走 `face` 参数（`R = face/2 - 29`，246 → 94 正好是原来写死的值）。
  面板里给 198，**抽屉里仍是 246** —— `.clock-pop` 的 278px 宽度是按 246
  配出来的（见上面「浮层的宽度要按内容盒算」），给它套小字会顶到边。
- **表盘上面那个大号的时间显示没有了**（`.cp-display` / `.cp-cell` / `.cp-colon`
  三块整组删掉）。生效时间早就写在横条那个按钮上（`.fast-clock .fc-t`），
  面板里再重复一遍纯属占地方 —— 这个面板只有 234px 宽，表盘已经占掉 198。
- **时 / 分圈的切换改由表盘正中心那个点承担**（`.cp-dot`，点一下切圈，
  上面写「时」/「分」）。那是**状态**不是提示：不写的话，同一个位置上那 12 个数
  是 12 点还是 12 分，只能靠数数猜。
- **「现在」在上午 / 下午那一组的右侧**，但那一组**仍然居中** ——
  所以「现在」是**绝对定位**，不是当第三个 flex 子元素（那样 `justify-content: center`
  会把三个一起居中，上午 / 下午整组左偏，而这两个键的居中是面板的视觉基准线）。
- **下午那圈写 12–23，不是 13–24**：24 点在钟面顶端对应的是 12 点（正午），
  标 24 会点出 12:xx，标签和结果对不上。13 落在 1 点钟位置，手感不用重学。
- **分钟那圈写 60,5,…,55**，跟真钟表的分钟圈一样，顶端那个 60 就是 0 分。
- **`ClockBody` 里没有 24 小时制的数字显示**，所以「上午 12 点 = 00:xx」这件事
  只在**横条按钮**和抽屉的时间框上看得到。别去面板里找那两个数。
- 「现在」跟着表盘走（它拨的是针），所以它在 `ClockBody` 里；
  「清除 / 取消 / 确定」是出口，留在 `ClockPop` 里。

**时钟按钮点下去先出日期面板、选完再出时间转盘**（需求 3）。
顺序是「日期 → 时间」：日期决定这条任务落在哪一天，时间只在有日期时才有意义。

- 日期面板是 `ui/DatePop.tsx` 的 `DatePop`，里面的月历 `MiniCalendar`
  **与顶栏「找日期」的 `JumpPop` 共用同一份**（`data-jump` / `.jp-*` 那套原样复用，
  连密度短横的 `loadOf` 都是同一个 `jumpLoad(state, iso)`）。别再写第二份月历。
- 时间那一层就是原来的 `ClockPop`，一行没改。
- **默认值由 `domain/model.ts` 的 `quickDefaults(ui, todayIso)` 给**，
  单测锁着：待办箱 = 无日期无时间；日程页 = 当前 `cursor` 那天（cursor 空就是今天）；
  其余（今天 / 逾期 / 打卡 / 已完成 / 项目）= 今天。放在领域层而不是 `Shell.tsx`，
  就是为了能被单测钉住 —— 它只读 `nav` 与 `cursor`，所以收 `Partial<UiPrefs>`。
- 生效值的优先级是 **面板选的 > 文本解析的 > tab 默认的**。注意时间那一档
  与旧版**相反**（旧版是「文本解析的 > 面板选的」）—— 用户刚在转盘上点的那一下
  必须赢过他打的字，否则就是「点了没反应」。
- 待办箱的默认是**无日期**，所以日期面板必须有「不选日期」这条出口
  （`.dp-foot` 里，另有「取消」只关面板、保留已选）。否则点开就只能选一个、回不去。
- 占位符**不随 tab 变**（`QUICK_PLACEHOLDER` 一个常量）。按 tab 换文案会让用户
  以为「切个 tab 我刚打的话被吃了」；已经打进去的字本来就是 React 状态，
  切 tab 不卸载 `QuickAdd`，所以不会丢。



**这一档的分法按「用户能不能操作它」，不按「有没有边框」。**

| 变量 | 亮 | 暗 | 要求 | 谁用 |
|---|---|---|---|---|
| `--border` | `#e8eaf0` | `#272c37` | **不要求 3:1** | 装饰分隔线 · 表面轮廓 · 中性填充 |
| `--input` | `#82889b` | `#71767f` | **≥3:1**（WCAG 1.4.11） | 交互控件描边 |

`--border` 画的是「两块东西挨着」，不是「这里能点」：时间轴刻度、月历格线、
卡片边、浮层边、进度槽（`.sp-bar` / `.wh-load`）、拖拽抓手（`.ms-grab` /
`.as-grab`）、置灰的完成胶囊。**一档兼「线」和「填充」是常见做法**
（Radix 第 6 步、Tailwind 的 `border-gray-200` + `bg-gray-200` 都是同一色值两用）。

`--input` 是输入框 / 下拉 / 勾选圈 / 幽灵按钮 / 视图切换 / 滚动条把手。
**勾选圈最要紧**：那个 20px 的空圈只有它自己说明「这里能点」，而这个应用
是给家里长辈用的。旧值亮 1.37 / 暗 1.53，等于没画。

**风格轴靠 `--border-w` 换「线」的粗细**：soft / notion 都是 1px，flat 是 2px
（Minimalist Flat 的硬边框感）。规则区里凡是全边的 `border: … solid …` 都引用它，
**别再写死 1px** —— 写死的那一处在切到 flat 时会原地不动。
`border: 1px solid transparent`（占位边框）不引用它：那种不参与视觉、只是撑尺寸
防抖动，加粗反而会挤动布局。
`app/tests/color-scan.mjs` 锁着这条（BANNED「写死的边框宽度」+ REQUIRED `--border-w`）。

> **旧名字 `--border-2` 和常见范式是反的。** 多数设计系统里带「2」的那个
> 是**更弱**的（Ant 的 `colorBorderSecondary` 就是），而它实际更强。
> 现在的名字取自 shadcn 的 `--input` / Material 3 的 `outline` / Primer 的
> `control-borderColor` —— 按**角色**命名，不按序号。
> 全仓 39 处引用已全部改名，`--border-2` 一个都不剩。

> **归类只认「能不能操作」，别按「长得像不像框」分。** 这么分过一次，
> 把提示框（`.conflict-box`）、邀请卡片、发出去的邀请那行虚线、
> 找日期浮层（`.jump-pop`，本来就带 `--shadow-lg`）全塞进了 `--input` ——
> 它们都是**表面**，走 `--border`。

**焦点环统一在 `legacy.css` 文件最末那一条 `:focus-visible`，不要再散着写。**

> **为什么必须和 `--input` 一起改。** 以前每处 `:focus` 只把描边染成
> `--primary`，**不新增任何像素** —— 那时前后对比是 3.73 / 3.64，刚好过
> WCAG 2.2 SC 2.4.11 要的 3:1。但 `--input` 一提到 3:1，这个对比就掉到
> **1.45 / 1.48**。**两件事是耦合的，只改一件会把另一件踩烂。**
>
> 现在改成画一圈**新增**的 2px `--primary` 外环：那些像素未聚焦时是底色、
> 聚焦时是 `--primary`，5.11（亮）/ 5.57（暗），且不依赖底色是什么。
> 各处原来那句「聚焦时描边染成 `--primary`」保留不动 ——
> **环 + 变色叠加才是常见做法**（Material 3 的文本框、shadcn 的
> `:focus-visible` 都是这样）。
>
> 用 `:focus-visible` 而不是 `:focus`：文本框在鼠标点入时也会命中它（浏览器
> 自带的判断），按钮则只在键盘走到时命中 —— 鼠标点按钮不该闪一圈蓝。
> 放在文件最末是为了压过各处零散的 `outline: none`（同特异度后写的赢）。
> `.view-switch > *` 例外：那个容器自己是 `overflow: hidden`，外环会被裁掉，
> 所以改成画在里面（`outline-offset: -2px`）。

### 变量名不许写错，也不许给兜底值

**新 surface（登录页 / 浮层 / `Btn`）原先写的是 `var(--accent,#4f7cff)` /
`var(--card,#fff)` / `var(--line,…)` 这一批，而这 6 个名字
（`--accent` / `--accent-soft` / `--card` / `--chip` / `--hover` / `--line`）
在 `legacy.css` 里一个都没定义。** 有兜底值，所以不报错、不白屏 ——
只是**两套主题下全都在用写死的浅色**：主按钮那个 `#4f7cff` 压白字只有 **3.70:1**，
暗色也没跟着 `--primary` 走。共 24 处，另有 11 处「名字对但兜底值是旧值」
（`var(--text-2,#5b6070)` 之类）。**静默降级比直接坏掉难查得多。**

> 现在的约定：`.tsx` 里引用变量**一律不给兜底值**。
> 写错名字会当场看得见（声明失效 → 继承），不会悄悄糊过去。
> 两套主题的对照表：`--accent`→`--primary`、`--accent-soft`→`--primary-soft`、
> `--card`→`--panel`、`--chip`→`--panel-3`、`--line`→`--border`、
> `--hover`→`--panel-3`、`--border-2`→`--input`（见上一节）。
>
> **CSS 里的兜底值不一样**：`var(--cols, 1)` / `var(--week-head-h, 79px)` 是真默认值
> （那两个变量由 JS 内联设置），保留。

`app/tests/contrast.mjs` 四段都在锁：① 74 对「文字 on 真会落上去的底色」≥ 4.5:1；
② 8 对**控件描边 ≥ 3:1**（WCAG 1.4.11，**和 4.5 那条是两条不同的线**，
每行自带 `min`）；③ `src/` 里引用了但 `legacy.css` 没定义的变量；
④ `.tsx` 里多余的 `var()` 兜底值。四段**都验过有牙**（改坏一处就 FAIL ——
`--input` 改回旧值会恰好报 4 条）。

**图标一律 lucide，零 emoji。** 弹层一律应用内，零原生 `confirm` / `alert`。

**金额相关一律不适用**（本项目没有金额字段）。

**「哪些页面跨集、哪些按集」是定死的**（用户 2026-10-06 裁决）：

| 跨集（看全部） | 按集（只看当前选中的） |
|---|---|
| 今天 · 逾期 · 待办箱 · 垃圾箱 | 日程 · 打卡 · 已完成 |

> 理由：清单类的东西「在哪儿都要办」，所以合在一起看；日程表是「这个集的
> 时间安排」，混着别人的会看不懂。
> 表达方式是 `App.tsx` 里给这几个视图传**哪一份 state**：
> `state`（全量）还是 `scoped`（`useScopedState()` 过滤过）。
> **不要**给 views/ 里的每个选择器加 `calId` 参数 —— 在状态这一层分叉一次，
> 下游十几个选择器一个都不用动，也不会有人忘了传。
> 侧栏徽标与顶栏一律用**全量**口径。

**只读成员看到的界面不是「藏起来」，是「点了会告诉你为什么」。**
`store.commitMany()` 挡下写入时 `denied` 计数 +1，`App.tsx` 弹一次提示。
**别让写操作静默失败** —— 用户会以为程序卡了。

> **记录只有 `store.ts` 的 `deny()` 一个入口**，别在调用点自己动 `state.denied`。
> 每个写入通道各记一遍必然漏 —— 漏过一次的就是 `moveToCal()`：它在自己的
> 函数里直接 `return`，用户点了「移到…」之后**连权限提示都没有**。
>
> **提示要点名是哪个集**（`deniedCals`）。今天 / 逾期 / 待办箱是跨集的，
> 在「今天」里勾了别的集的任务时，一句「这个日程集你只有查看权限」只会让人
> 以为是眼前这个集出了问题。一次操作只弹一条（一批里挡下几个集就列几个），
> 不是逐条弹 —— 那是刷屏。
>
> 另有一条**服务器侧**的兜底：客户端角色还是旧的时，op 会被服务端拒掉
> （`engine.ts` 的 `handleRejected`，`code: 'forbidden'`），那条走的是
> 顶栏 `lastError`，不经过 `deny()`。

**断网时界面也必须说话。** 顶栏 `.sync-dot` 的位置**离线优先**：
断网时显示一个 ☁︎ 划掉（`CloudOff`）配 title「离线，改动先存在本机，联网后自动同步」，
而不是那个会一直转下去的加载圈 —— 一直转看起来就是卡死了，而用户真正需要知道的
是「东西没丢」。数据本身早就在 outbox 里排队，这条只是把它说出来。
来源是 `ui/hooks.ts` 的 `useOnline()`（`navigator.onLine` + online/offline 事件），
**不是**「上一次请求成不成功」—— 后者每加一个探针就多一次请求。

**没有登录？有登录。** 但**没有密码找回、没有邮箱、没有第三方登录**。
**也没有管理员** —— 平等多用户、开放注册，注册完自动有一个「我的日程」，
之后互相邀请进同一个日程集。别把账本那套鉴权搬过来（那边是单密码
`auth.json`，这里是用户表 + JWT）。

> **别在界面上提「管理员」**，也**别写「第一个人是管理员」** ——
> 那是上一版的设计，`users.is_admin` 这一列已经没有了。

### 无障碍：三条不变量 + 一个已踩过的坑（2026-10-06）

**1. 每个控件都要有可访问名字。** 四种写法，按场合挑：

| 场合 | 怎么写 | 例子 |
|---|---|---|
| 有可见标签的输入框 | `useId()` + `<label htmlFor>` | `Drawer.tsx` 的日期 / 时间 / 时长 / 重复 / 备注 |
| 下拉框、没有可见标签的框 | `aria-label` | 管理浮层那两个角色 `<select>`、邀请用户名框 |
| 只有图标的按钮 | `<IconBtn label="…">`（`ui/kit.tsx`） | 抽屉的关闭、各类「删除 / 移出」 |
| 有文字的按钮 | 什么都不用加 | 可见文字**就是**它的名字 |

> **`placeholder` 不算名字** —— 它输入后就没了，只是最后一档的退化行为。
> 这一条踩过：探针本来接受 placeholder，于是管理浮层那个「名字」框
> **整整一轮没被任何断言看过**（它原来是个 `<div>`，不是 `<label>`）。
> 现在 `browser-smoke.mjs` 的 `nameOf()` 明确不接受 placeholder，别再加回去。

**2. 勾选圈一律走 `views/parts.tsx` 的 `<CheckBtn>`。** 六个调用点原先各写一遍，
于是各自长歪（月 / 周视图那个是 `<span>`、打卡和时间轴那两个没名字、逾期行的
标题写死成「标记完成」）。**别再手写 `span.check-btn`。**

**3. 命中区 ≥ 24×24（WCAG 2.5.8），但视觉尺寸不变。**
`.check-btn` 本体 18px、`.sm` 只有 14px，靠 `::before` 往外撑到 24 ——
**不是把圆点画大**，画大就毁了列表密度（`legacy.css` 那一段有完整注释）。

> 实测有个取整细节别当成 bug：整数步进的探针（`elementFromPoint` 往外走）
> 在 24 的边界上会读到 **23**。CSS 声明的尺寸是达标的，别为了这一格去改 CSS。
>
> 其余图标按钮本体只有 19–21px，走的是 2.5.8 的**间距豁免**（24px 圆不与
> 邻居相交即算达标）。要收紧得先量邻居 —— 一刀切加 padding 会撞上
> `.ci-item` 的 9px 内边距。

**锁在哪**：`app/tests/browser-smoke.mjs` 的**第五节**（管理浮层，联网时跑：
成员是拉的，断网后角色下拉根本不渲染）和**第十三节**（待办箱 / 抽屉 / 月视图，
断网后跑）。`a11y(root)` 收一个可选选择器，**扫浮层时一定要传** ——
不传就扫全文档，侧栏里任意一个没名字的控件都会算到浮层那条断言头上，
失败信息指错地方（这个探针里栽过一次，见踩坑 32）。

验过它有牙：把 `<CheckBtn>` 换回 `<span>`、或者拿掉一个 `aria-label`，对应那条立刻红。

### 键盘：一档微调，不做全套（2026-10-06 用户裁决）

> 「不需要过分考虑键盘操作，只要最简单的方向键能微调即可，其他的地方也是。」

**时间轴两个把手（`.ev-resize` / `.ev-resize-top`）是页面上仅有的两个
不可点、只能拖的控件** —— 其余每一个 `data-act` 都是真 `<button>`，Tab 就能到。
所以键盘支持只需要补这一处：两个 `<span>` 给上 `tabIndex={0}` + `aria-label`
（`views/Calendar.tsx`），方向键那一段在 `App.tsx` 的键盘委托里，
算法走 `domain/date.ts` 的 `nudgeEdge()` —— **和鼠标拖拽共用同一份算式**。

- 键位只有 ↑ / ↓。**方向跟着时间轴走**（往下 = `+1`），不是「变长 / 变短」：
  上沿往上拖是**变长**，跟着时间轴才不会在两边写出相反的符号。
- 一次一档 **15 分钟**，和拖拽的步进一致。
- 焦点在把手上时**只有方向键**被截走（`Return` 提前返回），
  `1/2/3` 切视图、`d/t` 跳页那些不受影响。
- **别再加别的键位** —— 用户明确说了不要。「其他地方也是」指的是
  「有没有第二个这样的控件」，查下来没有。

### 移动端软键盘避让：`--kb`（2026-10-06）

`dvh` 跟的是**布局视口**，而软键盘只压小**可视视口** —— 所以 `100dvh` /
`88dvh` 一个像素都不会躲。**固定定位的那几个面**（详情抽屉、`Sheet`、登录页）
浏览器也不会替我们滚上来的。所以：

- `ui/hooks.ts` 的 `useKeyboardInset()` 用 `window.visualViewport` 量出
  被遮的高度，写进 `document.documentElement` 的 **`--kb`**；
- 消费点三处：`kit.tsx` 的 `Sheet`（`pb-[var(--kb,0px)]`，无条件）、
  `legacy.css` 里 ≤900px 的 `.drawer`（`padding-bottom`，宽屏是侧栏面板、
  键盘盖不到）、`ui/Auth.tsx` 的登录卡（`pb-[calc(1.5rem+var(--kb,0px))]`）。
- 登录卡还额外改成 **可滚 + `my-auto` 居中**，不用 `items-center`：
  内容比容器高时居中会把顶裁掉且滚不上去。

> **页内正常滚动的输入框不用管** —— 那些浏览器自己会滚。
> 改了需要避让的固定面板，记得接上 `--kb`，别写死一个 padding。

**锁在哪**：`browser-smoke.mjs` **第十五节**。它只验**管道**（有人写 `--kb`、
有人读 `--kb`），**验不了**「visualViewport 变化 → 算出多少像素」那一步 ——
无头里造不出真软键盘（和触屏那条同理，真机手感只能人看）。
验过它有牙：把 Sheet 那句 `pb-[var(--kb,0px)]` 摘掉重跑，
「容器读到了 --kb」当场变成 `0px`。

### 浮层的语义与焦点（2026-10-06）

**凡是真的盖住整页的浮层，必须同时做四件事**，少一件就有一句是假话：

| 做什么 | 在哪 | 少了会怎样 |
|---|---|---|
| `role="dialog"` + `aria-modal="true"` + 名字 | `Drawer.tsx`（`aria-label="任务详情：<标题>"`）、`kit.tsx` 的 `Sheet`（`aria-labelledby` 指向标题那个 `div`）、`Shell.tsx` 的 `MoreSheet` | 读屏只念到一堆孤立的输入框，不知道它们在一片对话框里 |
| **`useFocusTrap(panel, open)`** | `ui/hooks.ts`，三个浮层都挂 | `aria-modal` 是对读屏的承诺「外面别念」，Tab 却能走到背后 —— 那句承诺当场变成假的 |
| 开时把焦点送进**面板本身**（`tabIndex={-1}` + `panel.focus()`） | `Drawer` / `Sheet` / `MoreSheet` | 送进第一个输入框会**当场弹出手机软键盘**，而用户点一行往往只是想看看（用户明确要求过：别抢焦点弹键盘） |
| 关时 `prevFocus.focus()` 还回原处 | 同上 | 焦点掉到 `body` 上，键盘用户得从页首重新 Tab 一遍 |

两条实现细节：

- **记录「原来那个元素」之前先看焦点在不在浮层里**（`panel.current?.contains(document.activeElement)`）。
  从一条任务切到另一条时 `id` 变了但组件不卸载，这时 `activeElement` 就是浮层自己，
  记下来等于把「还回哪」擦掉。
- 遮罩加 `aria-hidden="true"`：它只是个鼠标目标（键盘走 Escape），别让读屏念一个空 div。
- `.drawer:focus-visible` / `[role="dialog"]:focus-visible` 在 `legacy.css` 末尾
  **关掉焦点环** —— 一圈 2px 顺着整个浮层轮廓跑，看着像界面坏了。
  （必须写在 `legacy.css` 里：Tailwind 的 `outline-none` 在 `@layer` 里，压不过它，见踩坑 17。）

**锁在哪**：`browser-smoke.mjs` **第十六节**。它从**最后一个**可聚焦元素按 Tab
（从中间按证不了什么 —— 前后都在浮层里，圈不圈都一样），再按 Escape 看焦点有没有
回到开浮层前那个输入框。验过它有牙：一次把 `useFocusTrap(panel,false)`、
`panel.focus()`、勾选圈的 `aria-label` 三处同时改坏，
「焦点落在面板本身」「Tab 绕回抽屉里」「抽屉里每个输入框都有名字」三条当场红。

> **抽屉头上那个勾选圈原先 `display:none`** —— 那是把它从无障碍树里整个摘掉
> （读屏不知道任务做没做完，键盘也够不着）。现在是「看不见但还在」
> （1px、透明、出流，视觉零变化），焦点环画在旁边那个可见的圈上，
> 名字走 `aria-label`（包着它的 `<label>` 里一个字都没有，给不出名字）。

### 状态语义：`aria-current` / `aria-expanded` / `aria-haspopup`（2026-10-06）

这三个各有各的场合，**别混着用**（`aria-expanded` 摆在只是弹浮层的按钮上，
读屏会念成「已折叠」——那里根本没折叠这回事）：

| 属性 | 用在哪 | 判据 |
|---|---|---|
| `aria-current="page"` | 侧栏 `.nav-item`、底部标签栏 `.tab` | 「现在在哪一页」。视觉上靠 `.active` 那点底色，读屏只认这个 |
| `aria-expanded`（+ `aria-controls`） | 「今天已完成」的 `.td-head`、「找日期」的 `.jump-btn` | **真的是个折叠开关**：按一下展开、再按一下收起 |
| `aria-haspopup="dialog"` | 管理当前日程集 / 邀请收件箱 / 找日期 | 按下去会弹一个浮层，但开没开是 App 那一层的状态 |

> 后两个的差别就是「开没开这个状态**在谁手里**」。`.td-head` 和 `.jump-btn` 的
> 开合是组件自己的 `useState`，白送一个 `aria-expanded`；
> 管理浮层 / 邀请收件箱的开关在 `App.tsx`，两个布尔值要穿两层 props 才到得了
> 侧栏，而浮层自己已经在开的那一瞬间念出名字了 —— 那里只写静态的 `aria-haspopup`。
>
> 锁在**第十六节**最后三条：侧栏有且只有当前项带 `aria-current="page"`
> （和 `.active` 对得上），`jump-btn` 的 `aria-expanded` 跟着开合 `false → true`。

### 降低动态效果：全站关，只有「正在同步」例外（2026-10-06）

`legacy.css` **文件最末**一段 `@media (prefers-reduced-motion: reduce)`：
通配 `*` + `!important` 把 `animation-duration` / `transition-duration` 压到
`.01ms`、`scroll-behavior` 复位。

- **为什么不挑几个「大动作」**：会动的地方有十几处（抽屉 / 浮层的 .24s 位移、
  拖拽让位的 180ms、方块 hover 的位移、各处颜色过渡），挑漏一处就等于没关，
  而且日后再加一处也不会有人记得回来补。
- **唯一的例外是 `.animate-spin`**（同步中的加载圈）：它不是动效，是在说
  「正在同步，别以为卡死了」。停下来传达的正好是相反的意思。
- 这一条必须**压得过内联 style 和 Tailwind 层**，所以 `!important` 不是偷懒。

**锁在哪**：第十六节先量一遍**没开时**的值当基准，再 `Emulation.setEmulatedMedia`
切到 `reduce` 量第二遍 —— 不量基准的话「过渡是 0s」可能本来就是（压根没写过渡），
断言会假通过。注意 `getComputedStyle` 回的是**序列化后**的值：
写 `0.01ms` 它给你 `1e-05s`，所以按秒解析再比大小，**别比字符串**。

---

## 五、给 AI 的硬约束

1. **后端只许引 AI 那一组依赖，别的一律不许。** 其它全部用 Node 标准库
   （`node:http` / `node:sqlite` / `node:crypto`）。
   零依赖原本换来的是「十年后 `node server.js` 还能跑」，这个代价在 2026-10-06
   被用户明确推翻（原话：*「不要守着 0 依赖，那个没有意义，你可以积极去组合使用
   相关生态下的控件」*），为的是接 pi 的 agent 框架而不是手搓工具循环。
   **这是一次有范围的让步，不是「以后随便引」** —— 加 AI 之外的依赖仍然要先问。
   现状：`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`，两个都锁精确
   版本（没到 1.0，API 会动），装在本机磁盘而不是共享盘上（见 [DEPLOY.md](DEPLOY.md)），
   且 **pi 的调用只关在 `server/lib/ai/chat.mjs` 一个文件里** —— 升版时只改它。
   `server/lib/ai/confirm.js` 走 CJS 直接 require、一条都不碰 pi：依赖没装好时
   用户最需要的恰恰是把已经排好的改动确认掉。
2. **不引入 `v1` / `v2` 版本号并存。** 数据结构变了就归档旧 key + 写迁移。
3. **不改 nginx 的路径结构**（没有 `/schedule2/` 这种东西）。就一套路径，
   回滚靠换 `dist/` 的内容。
4. **前端的新依赖要先问。** `app/package.json` 里现在有 11 个 dependency，
   每一个都是「现有视觉做不到才加的」。标准库 / 现有依赖能做的，别加新的。
5. **`domain/` 保持纯净**：不含 React / DOM / 网络。它要能在 Capacitor 与
   Node 里直接跑，也是全部单测覆盖的地方。
6. **别在文档里写密码。** 任何示例都用占位符。
7. **权限判断只在 `canWrite` / `canManage` / `db.roleOf()` 三个入口。**
   散落的 `role === 'owner'` 是给自己埋雷。

---

## 六、部署

```bash
cd app && npm run build          # 前端产物 → ../dist/，刷新即生效
```

改了后端才需要 `systemctl --user restart schedule-backend`。
**完整细节（nginx、systemd、备份、回滚、排障）在 [DEPLOY.md](DEPLOY.md)。**
