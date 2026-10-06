# 日程清单

个人用的任务与打卡网页。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
**前后端分离**：React 前端 + 自写 Node 后端 + SQLite，数据在服务器上。

| 文件 | 读者 | 内容 |
|---|---|---|
| [README.md](README.md) | 人 | 网址、怎么用、数据在哪、日常命令 |
| `CLAUDE.md` | AI 编码助手 | **本文**：数据模型、代码约定、踩坑记录 |
| [DEPLOY.md](DEPLOY.md) | 人 + AI | nginx 怎么操作、conf 怎么写、发布流程、回滚 |
| [docs/接口.md](docs/接口.md) | 人 + AI | HTTP 接口一览 |
| [docs/重构路线.md](docs/重构路线.md) | 人 + AI | 2026-10-06 这次重写的决策记录 |

**改代码前先读「四、踩过的坑」和「五、界面约定」** —— 那些约束都是踩坑换来的。
改 nginx 配置或发布流程前读 [DEPLOY.md](DEPLOY.md)。

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
│   │   ├── App.tsx         串起来的那层（约 700 行，见下）
│   │   ├── domain/         纯逻辑，零 React / DOM / 网络依赖
│   │   │   ├── types.ts    LocalState · Task · Habit · Op
│   │   │   ├── date.ts     today / addDays / weekStart / monthMatrix / fmt* / shortLoad
│   │   │   ├── parse.ts    自然语言解析（规则顺序敏感，见四、35）
│   │   │   ├── repeat.ts   重复推进 + seriesRootOf + 派生 id
│   │   │   ├── layout.ts   HOUR_H 等时间轴常量 + layoutOverlap
│   │   │   ├── model.ts    counts / liveTasks / dayLoad / 各种选择器
│   │   │   ├── merge.ts    逐字段 LWW 客户端侧合并 + findConflicts（冲突判定）
│   │   │   ├── ai.ts       AI：SSE 行解析 + 工具调用→人话 + 提案→人话（纯逻辑，见二、AI）
│   │   │   ├── ai.test.ts
│   │   │   └── domain.test.ts
│   │   ├── data/
│   │   │   ├── store.ts    localStorage 持久化 + 增删改查 + ui.* （K = schedule-app-v4）
│   │   │   ├── api.ts      fetch('./api/…') 封装、令牌、缓存的 user
│   │   │   ├── device.ts   设备标识（K = schedule-app-device）
│   │   │   ├── legacy.ts   读旧版 schedule-app-v1，只读不删
│   │   │   └── store.test.ts
│   │   ├── sync/engine.ts  outbox 推送 + 游标拉取 + 轮询调度 + 拖动守卫
│   │   ├── ui/
│   │   │   ├── Shell.tsx   侧栏 / 顶栏 / 底部标签栏 / 更多抽屉 / 快速添加 / 找日期
│   │   │   ├── Calendars.tsx  日程集：侧栏切换条 · 管理浮层 · 邀请收件箱
│   │   │   ├── Drawer.tsx  抽屉（详情 + 编辑 + 「另一台设备也改过」那条提示）
│   │   │   ├── ActSheet.tsx  长按操作层（触屏专用，在「提起后原地松手」时出现，见四、14）
│   │   │   ├── Auth.tsx    登录 / 注册（开放注册，无管理员）
│   │   │   ├── AiPanel.tsx  AI 对话面板：气泡 + 动作条 + **提案卡片**（点确认才落库）
│   │   │   ├── AiSettings.tsx  Base URL / 模型 / key 的设置浮层
│   │   │   ├── aiClient.ts  fetch + ReadableStream 读 SSE（带 Authorization）
│   │   │   ├── kit.tsx     Btn · IconBtn · useConfirm · ConfirmProvider · ToastHost
│   │   │   ├── dnd.ts      **让位洞**拖拽层 + 触屏那条 pointer 通路（最易踩坑的一块，见四、8 与四、14）
│   │   │   ├── dragState.ts  模块级「正在拖」标志，给 sync 守卫用
│   │   │   ├── hooks.ts    useStoreState / useScopedState / useIsNarrow / useOnline / useOutsideClose
│   │   │   └── cx.ts
│   │   ├── views/          纯展示，零回调，只出 data-* 属性
│   │   │   ├── Calendar.tsx  DayView · WeekView · MonthView · useViewLayout
│   │   │   ├── Lists.tsx     待办箱 · 今天 · 逾期 · 已完成
│   │   │   ├── Habits.tsx    打卡
│   │   │   ├── Trash.tsx     垃圾箱
│   │   │   └── parts.tsx    行/方块等共享小组件
│   │   └── styles/
│   │       ├── legacy.css  旧版那 68 KB 设计系统，**不带 @layer**（见四、27）
│   │       └── tailwind.css  样式入口 + 新表面的少量 CSS
│   └── tests/
│       ├── smoke.mjs          端到端冒烟（无头 Chromium + CDP，零 npm 依赖）
│       └── browser-smoke.mjs  新界面照一遍：注册 → 切集 → 改名 → 接受邀请 → 触屏/鼠标拖拽 → 断网
│
├── server/                 后端（Node 22，**只引 AI 那一组依赖**，见六、1）
│   ├── server.js           路由表 + 处理器 + 鉴权中间件
│   ├── lib/db.js           node:sqlite：建表 / field_state / changes / users / cals
│   ├── lib/auth.js         scrypt 哈希 + 自签 JWT + 用户名口令校验
│   ├── lib/sync.js         逐字段 LWW + 快照 + 全量游标增量 + 按集鉴权
│   ├── lib/calendars.js    日程集：建 / 改名 / 删 / 退出 + 成员与角色
│   ├── lib/invites.js      邀请：发出 → 待接受 → 接受 / 谢绝 / 撤回
│   ├── lib/ratelimit.js    定点窗口限速（登录 / 注册 / 邀请 / AI）
│   ├── lib/ai/             **AI 唯一能碰 pi 的地方**（见二、AI；依赖见六、1）
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
│       ├── api.test.js        37 条接口用例
│       ├── migration.test.js  schema 迁移（**唯一会吃掉用户数据的代码**）
│       ├── ai.test.js         18 条 AI 层用例（假模型，不联网）
│       └── smoke-share.mjs    真走网络：两个人共用一个集的全流程
│
├── dist/                   构建产物（生成物，勿手改；nginx 只伺服这里）
├── deploy/                 nginx conf + systemd 单元的本地副本
├── legacy/                 旧版纯静态应用，**冻结**（回滚用，见 DEPLOY.md 七）
├── docs/                   接口.md · 重构路线.md
├── package.json            只声明 AI 那一组依赖（见六、1），**没有 build 脚本**
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
先怀疑 Service Worker 发了一份旧版页面（见四、1），不是数据污染。

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

# 依赖装在**本机磁盘**上，不在共享盘（CIFS 上成千上万个小文件正是四、30
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

> **`node server/server.js` 从此不再自包含。** AI 那组依赖（见六、1）没装的时候，
> `server/lib/ai/index.js` 是**惰性 import**，所以服务照常起得来 —— 只是 AI 页
> 会报「依赖没装好」。确认提案那条路（`ai/confirm.js`）走 CJS 直接 require、
> 一条都不碰 pi，所以**依赖没装好也能把已经排好的改动确认掉**。
> 装法见 [DEPLOY.md](DEPLOY.md) 的「依赖」一节。

线上那份由 `systemctl --user` 管，见 [DEPLOY.md](DEPLOY.md) 2.4。

### 测试

```bash
cd app          && npm test                     # 77 条（node --test，跑 *.test.ts）
cd app          && npm run typecheck
npm test                                        # 根目录：server/tests/ 那三个 node --test 文件
node server/tests/api.test.js                   # 37 条接口
node server/tests/migration.test.js             # 8 条 schema 迁移
node --test server/tests/ai.test.js             # 18 条 AI 层（假模型，不联网不烧额度）
node server/tests/smoke-share.mjs               # 两个人共用一个集，真走网络
```

后面两个会**自己起一个临时后端**（临时数据库 + 随机端口），不碰线上那份。
`smoke-share.mjs` 覆盖的是单元测试测不到的东西：限速之外的所有跨用户路径 ——
邀请 → 接受 → 跨账号同步 → 降级为只读后被拒 → 移出后写不进去。

界面照一遍（真实 Chrome + CDP，零 npm 依赖）：

```bash
cd app && node tests/browser-smoke.mjs
```

它自己起一套**完全隔离**的环境（临时后端 + 带 /api 代理的静态服务 + 独立
Chrome profile），然后像人一样走：**第一趟就查缓存里有没有那 5 条** →
注册 → 侧栏出现日程集 → 六个视图都不白屏 → 管理浮层改名 →
**确认服务器上真改了** → 刷新还在 → 收到邀请 → 接受 → 切到新集 →
**长按提起 → 拖到别处排序 → 原地松手弹操作层** →
**鼠标拖拽同一套落点** → **被降成只读后提示点名集名** →
**另一台设备改过同一字段 → 抽屉里那条提示 → 知道了** →
**AI 提案卡片 → 确认 → 服务器上真有** →
离线小标 → **把静态服务关掉还能打开**。
全程收集 console 报错，有一条就算失败。

> 之所以不用 `vite preview`：它的代理写死指向 25692，**那是线上后端**，
> 探针会往生产库里写账号。隔离是这里的第一要求。
> 浏览器路径用 `CHROME` 环境变量覆盖，默认 `/opt/google/chrome/chrome`。

> **第八节（触屏）和第九节（鼠标）测的是同一件事的两个入口。**
> 两条路共用 `applyDropAt` / `finishDrag` / `commitDrop`，所以第八节证的是
> 「手势对不对」，第九节证的是「鼠标这条**接线**还通着」——
> 重构共享代码时最先坏的就是 `dragstart` / `dragover` 那几个 handler 的接线，
> 而触屏那条根本不发这些事件，光靠第八节看不出来。
> 验过它有牙：**把 `onDragStart` 里的 `dragId = id` 删掉**，只有第九节失败
> （3 条），第八节照常全绿。

> 离线那一段有两处是**为了让断言有牙**才那么写的，别当成多余的：
>
> - 探针自己的静态服务对 HTML 回 `cache-control: no-store`。不然服务器关掉之后
>   Chrome 自己的 HTTP 缓存也能把 index.html 交出来，测试会假通过
>   （真实 nginx 给 `/schedule/` 配的也是 no-cache）。
> - 关服务前要 `closeAllConnections()`。光 `close()` 只停止接受新连接，
>   Chrome 池子里那条 keep-alive 还能把请求送进来，同样是假通过。
> - **「第一趟就查缓存」必须在第一趟查**（探针的第「零」节，在第一次导航之后、
>   任何刷新之前）。放到后面查就区分不出「安装时预缓存了」和「后来被动存下来的」——
>   而后者正是线上踩过的那个坑：真实站点上第一次访问 `caches` 是空的。
>
> 验过它有牙：**把 `dist/sw.js` 挪走再跑，探针会在「Service Worker 接管页面」
> 那一步中断**。改这块之后建议照做一遍。

> 探针里的 `waitFor` 条件要**只可能因为那件事成立**。踩过一次：等
> 「成员列表加载完」写的是 `innerText.includes('创建者')`，而那是 ROLE_LABEL，
> 发邀请那个 `<select>` 的 `<option>` 里就有一个 —— 浮层一开就成立，等于没等。
> 失败信息是「成员列表里有自己」，指向完全错的地方。现在等的是成员**条数**非零。
> 另外它**不能以换行开头**（ASI 会把 `return` 断成空语句），见「四、39」。

> 第「十」节专测**只读成员被挡下时的提示**：真把爸爸降成 viewer → 真点勾选
> → 真看提示里有没有集名。分两段等（本地 cals 的角色先、DOM 后）—— 合成
> 一个条件的话，超时时分不清「同步没发生」和「同步到了但界面没画」。
> 写这一节时踩到「合成点击少了 pointerdown」，见「四、40」。

> 第「十一」节专测**冲突提示的接线**：判定本身在 `domain/merge.ts` 有单测，
> 这里证的是「引擎把这一轮推的 op 和这一轮拉回的改动对上了没有」。
> 做法是从 Node 侧用**另一台设备**的 `deviceId` 推一条 ts 更晚的改动
> （ts = 现在 + 30 秒 → 那边赢，最吓人的那种：用户刚打的字变回去了），
> 再在本机改同一个字段、真点开抽屉看那条提示、真点「知道了」看它落盘。
> 验过它有牙：把 `engine.ts` 里那句 `store.addConflicts(...)` 拔掉重建，
> 只在「冲突记到本地」那一步中断。
> 写这一节时踩到 `persist()` 防抖（见「四、41」）和 waitFor 只吃表达式（「四、42」）。

> 第「十二」节专测 **AI 写路径的接线**：模型调工具 → 工具造提案 → SSE 推卡片 →
> 用户点确认 → 服务器落库。它自己另起一个 **40 行的假模型服务**（说 OpenAI
> chat-completions + SSE，第一轮吐一个 `create_task` 的 tool_call、第二轮吐文本
> 收尾），所以不联网、不烧额度。四条断言分别卡：卡片文案对 → **确认之前**服务器上
> 没有 → 确认之后有 → 那条的 `_dev.title === 'ai'`（证明是 AI 这条路写的，
> 不是碰巧被别的路径建出来的）。
> 假模型服务返回的流**必须以 `data: [DONE]` 结尾**，SDK 认这个（见
> `openai/src/core/streaming.ts:133`），漏了就一直等。
> 写这一节踩到三个探针自己的坑：`.ai-input` 是 **textarea**，value setter 要用
> `HTMLTextAreaElement` 的原型（拿 `HTMLInputElement` 的来 call 会当场
> `Illegal invocation`）；`snapshot.tasks` 是**按 id 索引的对象**不是数组
> （见 `server/lib/sync.js` 的 `snapshot`），写 `.some()` 直接 TypeError。

`app/tests/smoke.mjs` 是更早那份冒烟脚本，头部写死了本机 Chromium 路径
（`CHROME` 可覆盖，默认 `/home/xiaokubao/.local/bin/chromium`）。

其余探针坑见「四、33」。

> **旧版根目录那个 `package.json`（`npm test` 空转的那个）已经没有了，
> 但 2026-10-06 又建了一个新的** —— 就是现在这一个，只声明 AI 那一组依赖，
> 外加一个 `test` 脚本跑 `server/tests/` 里那三个 `node --test` 文件。
> **前端仍然只在 `app/` 里跑**：`cd app && npm test`。

---

## 四、踩过的坑（改代码前先看这里）

### 同步 / 数据

**1. 两个 Service Worker 会打架：拆旧的那个必须只跑一次**

旧版注册过 `sw.js`（`CACHE = 'schedule-v12'`），缓存里有**旧版 index.html**。
网络优先，所以通常刷新就拿到新页面；但离线 / 抖动时它会回旧 HTML，
那份 HTML 又去加载 `app.js` / `views.js`，用户看到的是上一版界面，
而且「怎么刷新都不变」。

新版**自己也注册 Service Worker 了**（`app/public/sw.js`，断网时能把应用打开）。
于是「注销作用域内所有 SW」那一招会把自己刚注册的也干掉，而且每次启动都要
白白多转一圈。所以拆旧 SW 那段（`main.tsx` 的 `migrateAwayFromLegacySW()`）
用 **localStorage 标记 `schedule-sw-migrated` 锁成一次性**：

- 跑过就跳过；不支持 SW 的环境也要记标记，否则每次进页面都走一遍
- 删缓存时只认 `/^schedule-v\d+$/`，**新版那个 `sched-shell-*` 不能删**
- 重载仍要带 `sessionStorage` 标记 —— 没有它，只要每轮都「清理成功」
  就会无限刷新，这是无头测试里最容易把浏览器挂死的一类 bug

**新版 SW 的策略**（`app/public/sw.js` 文件头有完整说明）：

| 请求 | 策略 | 为什么 |
|---|---|---|
| `/api/*` | **不碰** | 引擎自己管重试与发件箱；缓一个接口响应会让用户拿过期数据当最新的 |
| 导航 | 网络优先 + 回落缓存的 index.html | **不能反过来** —— 缓存优先正是旧版那个病根 |
| `/assets/*` | 缓存优先 | 文件名带内容哈希，同一 URL 内容永不变 |
| 其余同源 GET | 先给缓存、后台更新 | 图标 / manifest |

**预缓存清单是装的时候现场抠的**（`precacheShell()`）：fetch `index.html`，
正则抠出里面的 `/assets/…`，加上写死的 `manifest.json` / `icon.svg` 一起存。
写死在源码里会在下次 `npm run build` 后立刻过期 —— 文件名带哈希。

> **这一步不能省。** 少了它，第一次访问是**存不下东西**的：那一趟的资源早在
> SW `activate` 之前就直连网络拿完了，于是「断网能用」要等到**第二次打开**才有。
> 线上实测发现过（真实站点 `caches.keys()` 是空的），所以探针第「零」节专门
> 在第一趟就断言缓存里已经有那 5 条。
>
> 前提仍然是「联网打开过一次」。从没访问过的设备断网打开只会看到 `COLD_OFFLINE`
> 那张兜底页。

> **改 `sw.js` 的缓存策略要顺手改 `CACHE` 名**（现在是 `sched-shell-v1`），
> 否则 `activate` 里删旧缓存那一步不会触发。
> 但 `sw.js` 文件本身**不用**加版本 —— 浏览器每次导航都会重新校验它
> （nginx 给 `/schedule/` 配的是 `no-cache`）。
>
> **dev 下不注册**（`import.meta.env.PROD` 判断）。否则缓存会在改代码时把
> dev 也一起骗了，正好是「改了代码但浏览器没生效」那个坑的翻版。
> `npm run preview` / 探针是生产构建，会注册。

**2. 拖动期间不要拉同步**

远端变更落地 → React 重绘 → 让位用的 `transform` 和占位洞全部重建 →
用户看到的是「拖到一半整个列表弹回原位」。

修法在**唯一的卡口**上：`sync/engine.ts` 的 `syncNow()` 开头
`if (isDragging()) return;`。拖动只有几秒，跳过这一轮没有代价 ——
outbox 还在，下一个轮询或下一次本地改动自然会把它推上去。

**3. LWW 是逐字段的，不是整条**

整条任务做 LWW：手机改标题、桌面改日期，后同步的那方会把对方**整个字段集**
覆盖掉，用户看到「我改的东西凭空没了」。逐字段的代码量几乎一样，但两个改动都留得住。

> **逐字段 LWW 有个副作用要说出来**：手机上改了标题、桌面上也改了标题，
> 后同步的那台会看到「字自己变了」，因为它压根不知道另一台也动过。
> 所以同一个字段两边都改过时，任务详情里会多一条只读提示（见二、同步末）。
> 提示本身不改数据 —— LWW 已经判完了，它只是把判决结果说出来。

**4. 幂等不靠 oplog**

LWW 的比较键 `(ts, deviceId)` 由客户端在**创建 op 时固定**并持久化在发件箱里。
同一条 op 重放时比较键完全相同 → `ON CONFLICT` 的 `WHERE` 不成立 → 一行都不改。
所以**不要**再加一张「这批 op 处理过了」的表。

**5. 时间戳只拒绝、不钳制**

钳制过一版，问题是钳制值取决于「收到请求的那一刻」，同一条 op 重放两次会钳出
两个不同的时间戳，**幂等性当场破掉**。现在改成超过 24 小时就退回并标
`code: 'clock'`，客户端留着不丢、等时钟校准后自然能推上来。

**6. 旧数据导入：先同步，再看账号空不空 —— 顺序不能反**

`sync/engine.ts` 的 `bootstrap()` 里是 `await syncNow()` **之后**才判断
「要不要把本机的旧数据搬上来」，而且判据是**服务器账号里有没有东西**、
不是本地 localStorage 空不空。

> 反过来写在第二台浏览器上登录就会出事：那台机器的 localStorage 里可能还留着
> 旧版的演示数据，于是把别人的任务倒进一个**已经有内容**的账号里。

另外导入完要再 `syncNow()` 一次，否则数据只在本机、刷新就没了。

### 前端 / UI

**7. `data-drop` 必须挂在有 padding 的元素的祖先上**

这是「有的任务拖不动」的真正根因，踩过两次。`data-drop` 原先挂在**内层**
`.allday-items` 上，而它有 `padding`：拖到 padding、任务之间的空隙、容器边缘时
`e.target.closest('[data-drop]')` 找不到 zone，`dragover` / `drop` 直接 return，
**静默失败，无任何报错**。用户感知就是「有的能拖、有的不能」。

修法：`data-drop` + `data-date` 上移到最外层 `.allday-zone`，内层纯做布局。

**8. 拖动排序用「让位洞」模型，不是插入线**

拖动时其他任务**实时地、平滑地挪开**，在光标处留出一个占位洞 `.drop-hole`，
落点由「洞在哪」直接表达。位置本身就是位置，不用一条线去暗示。

之前是「静态插入线 + 目标格描边」，视觉上对，但拖起来是「刻板」的：
线条只在跨过格子边界时跳一下，中间一大段位移完全没有反馈。
**不要再退回插入线模型。**

关键取舍：**不用 FLIP（先量后补 transform），而是直接改 DOM 顺序 + CSS transition。**
HTML5 拖拽里每帧改 DOM 顺序代价太高，而且 transition 会和 dragover 的重排互相打断。
实测 **180ms**（`.18s cubic-bezier(.22,.61,.36,1)`，在 `legacy.css` 里）足够顺，
逐帧插值反而更黏。

四个辅助函数 + 让位本体（都在 `ui/dnd.ts`，那段开头的长注释解释了演进过程）：

| 函数 | 职责 |
|---|---|
| `zoneCells(zone)` | 按**视觉 row-major** 排出条目。含被拖元素自己。不按 DOM 顺序 —— DOM 顺序等于 row-major 只在 grid 没改过 auto-flow 时成立 |
| `inferCols(cells)` | 按几何推列数：同一行里最多几个格子 |
| `cellUnder(e, cells)` | 找光标落在（或最近）的格子 |
| `refForIndex(cells, k)` | 把位次 k 翻译成排序接口要的 `(refId, pos)` |
| `shiftCells(cells, k, cols)` | **让位本体**：其余格子各挪一格 |

**判定只看「光标落在哪一格」，不比较到各条线的远近。** 用「最近线段」会串行：
光标在格子中心时，上方那条线反而更近，于是整片区域被判成同一档，
左右拖动又变得没准头 —— 这正是「只有横线、左右全靠猜」的病根。

**五条实现铁律**：

- **位置一律按 dragstart 时量的原始布局（`rawLayout`），不能用实时坐标。**
  让位是加在元素上的 `transform`，`getBoundingClientRect()` 读到的是**位移后**的值。
  拿它当基准，第二次判定会整体偏掉一格 —— 实测跨行拖动时整列被甩出容器。
- **`left` / `top` 都得按容器坐标算。** 洞是 `position:absolute`，只设 `left` 的话
  它会一直停在原处 —— **DOM 顺序变了、落库也对，就是看不见**。这类 bug 很隐蔽。
- **只有落点真的变了才动 DOM 顺序。** `dragover` 每秒能触发几十次，
  每次都重算会让让位动画一直重启，看起来反而更卡。
  用 `key = scope + '|' + k + '|' + cells.length` 去重。
- **被拖元素留在原位压暗，不参与位移**（`shiftCells` 里 `i === selfIdx` 直接跳过）。
  让它也滑到目标格会与洞叠在同一处 —— 两份占位重叠、原位又空出来，比不做更乱。
- **让位方向必须整段统一，不能逐格算**：夹在「出处」和「目标」之间的格子，
  一律朝**远离出处**的那一侧挪一格（`step = k > selfIdx ? -1 : 1`）。
  曾经写成逐格判断 `i < k ? i+1 : i-1`，符号是反的 —— 单列下相邻两格会挪到
  同一位置，**画面上凭空少一条任务，洞也被压在下层看不见**。

> 最后一条的失败症状很有欺骗性：**落库顺序完全正确**、DOM 也动了，只有画面重叠。

**洞的增删**：`clearHole()` 独立成函数，与 `clearBusySrc()` 一样不要塞进
`clearDropUI()` —— 后者每次 `dragover` 都会被调，会把标记立刻抹掉。
（现在 `clearDropUI()` 只干两件事：删 `.tl-guide`、调 `clearHole()`。）

> `zoneCells` 按 `zone.dataset.kind === 'habit'` 在 `[data-habit]` 与
> `[data-untimed="1"]` 之间切换 —— **打卡列表也走这套排序**，别以为只有任务能拖。

**落点相关的类名对照**（改样式前先认准当前用的是哪个）：

| 类 | 用途 | 状态 |
|---|---|---|
| `.drop-hole` | 占位洞（当前模型） | 在用 |
| `.drag-muted` | 让位开始后被拖元素淡出（**只在鼠标那条路上加**，触屏是靠浮起来的位移表达） | 在用 |
| `.touch-drag` | 触屏长按「提起」后的抬起阴影（`tailwind.css` 里的新表面，别去 `legacy.css` 找） | 在用 |
| `.tl-guide` | 时间轴落点线 + 时间徽章 | 在用 |
| `.tl-busy.drag-src` | 拖走时隐藏原位置的占用底纹 | 在用 |
| `.ins-line` / `.ins-bar` / `.ins-hl` | 旧插入线模型 | **已彻底删除** |

> `.ins-*` **连 CSS 规则都没了**，`legacy.css` 里只剩一句提到它们的注释
> （第 823 行附近，说明「这套已废弃」）。别照着旧文档去找它们的样式。

**时间轴落点仍是画线**（`.tl-guide`），没有改成洞 —— 时间轴是连续坐标不是列表，
「让位」在那里没有对应概念。这两种落点表达不要混。

**9. 拖到视口上下缘会自动滚屏**

`runAutoScroll()` 用 `requestAnimationFrame` **持续**滚，不是在 `dragover` 里挪一点 ——
`dragover` 的触发频率跟着鼠标走，鼠标不动就不触发，滚动会一顿一顿的。
上下各 84px 进入滚动区（`dnd.ts` 的 `EDGE = 84`），最快每帧 17px
（`MAX_SCROLL = 17`），越靠边越快。

**滚完位置变了，落点必须按新位置重算**，否则洞会停在旧处。
`runAutoScroll` 里因此要保留 `dragProbe` / `dragProbeZone` 并重新调 `showDropGuide()`。

**10. 高度一律用 JS 实算，不要写 `calc(100vh - N)`**

浏览器工具栏、缩放、系统字号都会让那个 N 猜错（实测差 22px）。正确做法：

```js
var cs = getComputedStyle(el);
var avail = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
```

用它的地方是 `views/Calendar.tsx` 的 `availHeight(el)` / `useViewLayout()`。
**旧版叫 `Views.fitWeekHeight` / `fitMonthHeight`，名字已经没了**（现在是同一个
`fit()` 里分支处理周视图和月视图），改代码时别照着旧名字找。

那段 `fit()` 还负责写 `--week-head-h`（周视图表头的实测高度），
因为周视图未定时行的 `sticky` `top` 取的就是这个变量 —— 写死必错
（CSS 里的兜底值是 `var(--week-head-h, 79px)`）。

**11. 月视图必须能滚**

`fit()` 里对月视图**只写下限**，不均分：
`gridAutoRows = minmax(下限, auto)`（先清掉 `gridTemplateRows`，
不然旧的 `repeat(6, 1fr)` 会把它压住）。
`auto` 让内容多的行自己长高 → `.content` 出现滚动条 → 滚轮可用。

早期版本把富余高度「均分」到 6 行强行铺满一屏，结果 1920×1080 下每行拉到 167px
却只塞 3 条任务（大片空白），而且刚好铺满时 `scrollHeight == clientHeight`，
**滚轮怎么滚都没反应**。

常量都在 `views/Calendar.tsx` 顶部：
`MONTH_ROW_MIN=104` / `MONTH_ROW_MAX=132` / `MONTH_HEAD_H=30` / `MONTH_CELL_MAX=8`，
下限的算式是 `clamp(MONTH_ROW_MIN, (可用高 - MONTH_HEAD_H) / 6, MONTH_ROW_MAX)`。

> 「每格直接列出几条」**不写死**，超出的折叠成「还有 N 项」并加 `data-jump`
> 可点进那天的日视图。上限不能太大：15 会把整行撑到几百像素、同行其他天全被拉空。

**12. 窄屏断点 900px，`isNarrow()` 与 CSS 媒体查询必须一致**

`ui/hooks.ts` 的 `useIsNarrow()` 用 `matchMedia('(max-width: 900px)')`，CSS 里对应
`@media (max-width: 900px)`。**改一处必须改另一处**，否则标签栏与侧栏的显隐会打架。

≤900px 侧栏收进「更多」抽屉，改用底部 `.tabbar`（今天 / 日程 / 待办箱 / 逾期 / 更多）。
**逾期必须留在底栏**（用户重视的功能，不能藏进「更多」）。
浮层 z-index 必须 > 标签栏的 45，否则抽屉被标签栏压住一截（现在用 60 / 61）。

> `styles/legacy.css` 里**另有** `@media (max-width: 820px)` 与 `(max-width: 640px)`
> 两处，那是排版微调（字号、间距），**不是**响应式断点，别混。

**13. 顶栏绝对不能加 `position` / `z-index` / `sticky`**

会生成层叠上下文，把里面的找日期面板（z-index 60）困住，导致被下方内容盖住变半透明。
实测踩过：窄屏下面板整个变半透明。窄屏下顶栏随内容一起滚反而省垂直空间。

**14. 触屏有 hover 落地、有拖拽，但两条路完全分开**

这一条的旧版内容是「触屏没有 hover，也没有 HTML5 拖拽，排序靠长按弹操作层」——
**后半句已经不成立**（2026-10-06 起触屏能拖了）。现在是：

- `@media (hover: none)` 处理 hover 才显形的元素（拖拽抓手、箭头、背景高亮）。**这条没变。**
- **鼠标走 HTML5 拖拽，触屏走自己那条 `pointer` 通路，两条路不共用输入，只共用落点。**
  输入那一段在 `ui/dnd.ts` 的文件头（`beginTouch` / `moveTouch` / `endTouch`）；
  落点那一段（`applyDropAt` / `finishDrag` / `commitDrop`）**是同一份代码** ——
  让位洞、时间轴预览、边缘自动滚屏都只有一处实现。改落点逻辑时两条路一起变，这是故意的。
- 触屏手势是**长按 → 提起 → 拖 / 松**：`pointerdown` 计时 `LONG_PRESS_MS = 480`，
  到点把行**提起来**（`.touch-drag`，抬起阴影；还**不是**拖动，只是「抓住了」的反馈）。
  提起来之后：
  - 挪过 `TOUCH_SLOP`（8px）才算「在拖」，此时才画落点；
  - **原地松手** → 弹长按操作层（`ActSheet`）。老路没丢，只是挪到了「提起之后」。
  计时只在 `pointerType !== 'mouse'` 时启用（鼠标继续走 HTML5 拖拽）。
- **抬手那一下必须把浏览器补的鼠标事件整串掐掉**（`swallowCompat` +
  非 passive 的 `touchend` 里 `preventDefault()`）。Chrome 在 `touchend` 之后会
  在同一个点补 `mousedown` / `mouseup` / `click`：提起后原地松手时操作层刚打开，
  这一串正好打在它的遮罩上，遮罩的 `onClick={onClose}` 当场把操作层关掉 ——
  **表现是「长按完什么也没发生」**，而事件日志里干净得看不出问题。
  只在「提起过」的那一次吞，普通点击不受影响。
- `lp.current.fired` 标志：长按生效后抬手那一下补的 `click` 要吞掉，
  否则会顺带打开抽屉。取消是容器上的 `onPointerMove` / `onPointerUp` /
  `onPointerCancel` / `onPointerLeave` 四个一起调的 `clearLp` ——
  **不是 capture 阶段拦截**（旧版是，新版走 React 的委托 `onClick`，
  在 `App.tsx` 的点击委托最前面一行 `return`）
  > **它的复位必须排在 `pointerDown` 里那次鼠标 `return` 之前。** 把它写在
  > 后面，鼠标这条路就永远不复位，长按过后用鼠标点的第一下被静默吃掉
  > （探针第「十」节第一次就是这么失败的，见四、40）。
- **动作值用无歧义前缀**：`dur60` 不是 `d60` —— 后者与 `del` / `date` 撞，
  靠 `+slice(1) > 0` 猜必然误伤。改动作值时按 `/^dur(\d+)$/` 匹配
- 窄屏下显式 `dragstart` → `preventDefault()`，避免某些移动浏览器模拟出半截行为
  （**只对 HTML5 那条路有意义**，触屏那条根本不发 `dragstart`）

> 触屏这条路**已经有自动化覆盖**了，见第三节「测试」与四、34 —— 不必只靠真机。
> 但探针证的是「指针事件管道通」，不是「真手指在真手机上顺手」。

**15. `moveInList` 的候选列表不能排除自己**

原来的实现 `filter` 时把被移动的任务自己排除了，`findIndex` 恒返回 -1，
`refIdx` 永远是 0 → **「下移」永远把任务插到最前面**。
现在用含自己的 `all` 定位、用排除自己的 `list` 取参照。

**16. 浮层外点击收起要用 `mousedown` + capture**

`useOutsideClose()` 里是 `document.addEventListener('mousedown', ..., true)`。
不用 capture 的话，面板内 input 的 blur 会抢先把它关掉。

**17. 输入框不要在编辑时重建**

换掉 DOM 节点或改正在编辑的那个 input 的 `value` 会让光标跳到开头。
`Drawer.tsx` 里标题 / 备注是**本地草稿**（按 `lastId` 的 ref 记住），
就是为了让「打字期间的重渲染」不至于把光标拽走。

**18. 日期密度指示用淡底 + 底部短横，不要用 4px 圆点**

找日期面板与月视图的日期格：有未完成任务的格子加淡底 + 一条短横，
横宽按任务数分 3 档（`.lv2` / `.lv3` 控制）。**圆点 4px 在 1x 屏上几乎看不见**。
窄屏下月视图格子压成圆点（`font-size:0`）是因为那里塞不进文字，与这里不是一回事。

**19. 时间轴方块是两行，短任务不渲染第二行**

`.tl-event` = `.ev-head`（勾选圈 + 标题）+ `.ev-time`（时间段）。
高度 < 46px 时**不渲染**时间行（15 分钟的短任务会被挤成两半）。
时间行样式明显弱于标题：`font-size: 10.5px` / `color: var(--text-3)`。

**20. 时间轴上下沿都可拖**

`.ev-resize` 是下沿、`.ev-resize-top` 是上沿（复用同一套样式）。
上沿拖动时 `ns = clamp(start + addMin, 0, end - 15)`，**底边固定**，
同时改 `time` 和 `duration`；下沿只改 `duration`。15 分钟步进。

> 测试时 `.ev-resize` **同时匹配上下沿** —— 用 `[data-act="resize-top"]` 区分，
> 否则会误判拉伸失效。

**21. 重叠任务按「重叠簇」分列**

`domain/layout.ts` 的 `layoutOverlap(events)`：先切成重叠簇
（`e.start < cur.end` 并入，否则另起一组），再在**簇内**贪心分列，每簇独立算 `cols`。

旧算法把全天所有事件塞进一个 `colEnds`，`cols` 取全天最大值，
于是**任何**一段重叠都会让当天所有方块一起变半宽 —— 不重叠的任务也跟着变窄。
日视图与 `weekTimed()` 共用此函数，占用底纹与方块宽度严格一致。

> **占位底纹 `tl-busy` 必须与方块同列宽**（`left: e.col*w%` + `width: calc(w% - 4px)`）。
> 原来 `left:0; right:0` 整条铺满，两个穿插任务叠在一起时整段时间被染色。

**22. 已完成的未定时任务不占日程位置**

`untimedOn(iso)` = `!t.time && !t.done`，日 / 周视图共用。
已完成的**定时**任务仍留在时间轴上灰显 —— 它占着具体时间段，抹掉会丢失
「那段时间做过什么」。

「今天」页有可折叠的「今天已完成」区块，状态存 `ui.tdoneOpen`，默认收起。
在里面取消勾选会让任务自动回到日程页。

**23. 侧栏顺序可拖动，`normalizeUi` 必须区分 undefined 与空数组**

状态存 `ui.navOrder`（全局顺序）+ `ui.navBottom`（哪些归底部 `#navBottom` 组）。
`#nav` 与 `#navBottom` 是两个容器，垃圾箱可以被拖进主区，反之亦然。

处理在 `domain/model.ts` 的 `normalizeUi()`：

> **`navBottom` 不能用「空则默认 `['trash']`」的写法** —— 那会把用户主动拖出底部的
> 垃圾箱又塞回去。必须区分「从未设置（`undefined` / 不是数组）→ 给默认」
> 与「空数组 → 用户有意为之，原样保留」。
> 代码里就是 `bottom === null ? ['trash'] : bottom`，`domain.test.ts` 有用例锁着。

其他坑：浏览器 `dragend` 后可能补一次 `click`（用 `navJustDragged` 标志 +
`setTimeout(…, 0)` 吞掉）；侧栏 active 高亮要用统一的 `$$('.nav-item')` 取，
不能分开写 `#nav` 与 `#navBottom`。

**24. CSS 层叠：同特异度后写的赢，给折叠元素加类要查 display**

`.habit-list { display:flex }` 声明在 `.mc` 之后会覆盖 `display:grid`。
同特异度下后写的赢，必须补 `.habit-list.mc { display:grid }` 提一级特异度。

`.td-body` 收起时 `display:none`，但 `.mc { display:grid }` 在后面会把它强制变成 grid
→ **折叠的「今天已完成」区块凭空展开**。必须补
`.today-done .td-body { display:none }` + `.today-done.open .td-body.mc { display:grid }`。

> 规律：**给折叠 / 隐藏元素加类时，一定要检查该元素的 `display` 规则与新类的层叠顺序。**

**25. `.mc` 是显式加的类，不是靠 CSS 猜子元素**

宽屏列表分列靠 `.mc`。它加在：待办箱 `.group-items`、今天主列表、
已完成 / 逾期 / 垃圾箱的每个分组内部、打卡 `.habit-list`、「今天已完成」明细。

**只有一档**：`@media (min-width: 1120px)` → `repeat(2, minmax(0,1fr))`，
`.mc` 的默认值是 `display: block`。容器 `max-width` 同时放宽到 1280px。

> **1560 / 2000 / 2560 那三档（3/4/5 列）已经被刻意删掉了**，别照着旧记忆加回来。
> 需求是「一行最多放两个」，容器太宽反而把每行的空白拉长。
> `legacy/tests/col-check.mjs` 就是锁这个约定的（它读**每个 `.mc` 容器自己**的
> `gridTemplateColumns`，不是页面的 —— 逾期/已完成按日期分组，每组是独立容器）。

整块内容（打卡条 `.checkin-strip`、逾期提示 `.od-strip`、`.today-done`、
`.trash-head`、`.habit-add`、`.empty`）用 `grid-column: 1/-1` 排除分列。
分列后 `.mc > .task-row/.habit-row` 的 `margin-bottom` 要清掉，改用 `row-gap: 7px`。

> 那个媒体块里还有一行 `.habit-list.mc { display: grid }` —— 是提特异度用的，
> 见上面「CSS 层叠」那条。

**26. 原生 `confirm()` 在 PWA 里会被静默吞掉**

用原生 `confirm()` / `alert()`，PWA 环境会**直接返回 `false`** ——
表现为「点了删除完全没反应」，用户看不到任何提示，代码却以为他点了取消。

**新版已全部换掉**：`ui/kit.tsx` 的 `useConfirm()` + `ConfirmProvider`
（应用内弹层，参考 `#actSheet` 的结构）。**别退回原生 `confirm`。**

当前 5 个调用点：

| 在哪 | 删/改什么 |
|---|---|
| `App.tsx` `del-habit` | 删除打卡项（连带打卡记录） |
| `App.tsx` `purge` | 彻底删除一项（所有设备上消失） |
| `App.tsx` `empty-trash` | 清空垃圾箱 |
| `App.tsx` `importBackup` | 导入备份 —— **是「合并」，不是覆盖**，文案里写明了 |
| `Drawer.tsx` 删除任务 | 软删除，可在垃圾箱还原 |

**27. Tailwind 4 的层叠：无层样式赢过一切**

Tailwind 4 把它的东西（含 preflight 重置）全部塞进 `@layer`，
而**没有层的作者样式永远赢过任何层内的样式**。所以 `tailwind.css` 里
`@import "./legacy.css"`（不带 layer）就压在所有 Tailwind 工具类之上 ——
这正是我们要的，legacy.css 是这个应用已经定稿的设计系统。

> **代价要说清楚**：在 legacy.css 已经覆盖的元素上，Tailwind 工具类**不生效**。
> 给 `.task-row` 加个 `mt-2` 是白写的。新表面（登录页、浮层、`.ms-user` 等）
> 用的是 legacy 里根本没有的类名，不受影响。
> 新样式的配色**跟着 legacy.css 的 CSS 变量走**（`var(--text-3)` 等），
> 写死颜色会让深色模式在新表面上失效。

**28. 事件委托：为什么 `views/` 组件不能有回调**

见「一、`App.tsx` 里那几件事为什么都在一个文件」。一句话：行会被重排 / 重绘替换，
挂在行上的 handler 会跟着丢。**新增交互时：在 `views/` 里出 `data-act` 属性，
在 `App.tsx` 的委托 switch 里加一个 case。** 别往 `views/` 里塞 `onClick`。

**29. 滚动位置要在 render 阶段读，不能在 effect 里读**

`useViewLayout` 要在重渲染前后保住 `.content` 和 `.week-view` 的滚动位置。
React 会先跑完整个 render 阶段再改 DOM，所以**在 render 体内读 `el.scrollTop`
拿到的是更新前**的值；放进 `useLayoutEffect` 读到的已经是清零后的 0。

### 环境 / 工具

**30. 工程目录在 SMB 上，偶发丢文件（**重要**）**

工程目录挂在 CIFS 上（`actimeo=1` `nobrl` `mapposix`，`/mnt/fnos` 还是个
`timeout=3` 的 autofs）。**2026-10-06 实测丢过一次 `app/src/App.tsx`**：
编辑工具写完当场还在，几十秒后整个文件没了，没有 recycle 目录、也不在 git 里。

- 传大文件先写到本机磁盘再 `cp` 过去，然后 `md5sum` 两端核对
- 写完 / 移动完**立刻 `ls -l` 确认还在**
- **改完就提交** —— `app/` 曾经没进版本库，那时唯一的后悔药是从会话记录里
  把 `Write` 调用的内容捞回来
- **别用 `perl -i` / `sed -i` 这类原地改写工具。** 它们靠「写临时文件再改名」，
  在 CIFS 上改名会失败，而且**原始文件会当场消失**（2026-10-06 实测丢了一次
  `app/tests/browser-smoke.mjs`，靠 `git checkout` 捞回来的）。
  要用编辑工具改，或者写临时文件再 `mv`
- 源码没必要放共享盘上

**31. `pkill -f "…"` 会打到自己**

`pkill -f "node server/server.js"` 连同一条命令里的 shell 一起杀掉（exit 144），
因为 zsh 的命令行本身就含这个字符串。

- **拆成两条命令**，别在同一条里既 pkill 又出现那个字面量
- 或者用端口：`fuser -k 25692/tcp`
- 写成 `node [s]erver/server.js` 只在「同一条命令里没有字面量」时才有用

**32. 非交互式 shell 里 `systemctl --user` 连不上总线**

```
Failed to connect to user scope bus via local transport:
$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined
```

AI / 脚本执行命令时都会撞上（没有登录会话）：

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
```

**33. 无头 Chrome 的坑（照抄即可）**

- 注入的脚本**后缀必须是 `.txt`**。`.js` 会被 MIME 猜测当 HTML 解析，报 `Unexpected token '<'`
- 用 `document.body.textContent` 搜中文会命中内联 `<script>` 源码本身，
  导致「已删除的文案仍存在」的假阳性 —— 改用 `document.getElementById('content').textContent`
- 合成 `DragEvent` 时 `target` 默认是派发元素（`content`），
  `e.target.closest('.task-el')` 找不到 → 派发前
  `Object.defineProperty(ev, 'target', { value: 真实元素 })`
- **不要在测试脚本里写 `location.reload()`**：内联脚本随页面重新执行 → 无限刷新，
  headless Chrome 挂住只能 taskkill
- 断言 CSS 生效优先看 `display` / `getComputedStyle`；
  transition 相关的 `opacity` 在无头 `--virtual-time-budget` 下读值不可靠
- `.tl-busy` 没有 transition 计时上下文，无头环境实测 `opacity` 读出来仍是 1，
  隐藏源底纹必须用 `display:none`
- `file://` 下 localStorage 在多个无头实例间**共享**，连续截图会串状态 ——
  每个截图必须给 `--user-data-dir=/tmp/xxx` 独立 profile
- iframe 跨文档：`file://` 下 `postMessage` 被拦，跨文档读 DOM 也不行，
  **只能用 `localStorage` 传递**（同源）。iframe 里的测试链要等跑完，
  外层用 `setInterval` 轮询，别用固定 `setTimeout`
- 用 python 写含 `\n` 的 JS 注入片段时容易转义出错 —— **直接用 Write 工具写探针文件**
- python 的 `str.replace` 若目标串不存在会**静默不替换** —— 要加 `assert old in s`
- 合成事件后调用了会触发重渲染的操作（如 drop），
  后续测试必须**重新 querySelector**，旧引用指向已脱离文档的节点，`getBoundingClientRect()` 全是 0
- 无头 Chrome 截图要 `--ignore-certificate-errors`
- 无头算「本周内某一天」时用 `weekStart(today)` 再偏移，
  不要直接 `today+2`，否则跨周时列不存在会拿到 null

**34. 无头 Chrome 有最小窗口宽度约 526px（窄屏仍测不了，但触屏能测了）**

`--window-size=390` 实测 `innerWidth` 是 526，量不到真手机宽度，截图也会被裁。

**窄屏那一套（≤900px 的标签栏、「更多」抽屉、`@media (hover: none)` 的排版）
仍然没有自动化覆盖，改那边只能靠手工在真机上看。**

> 旧版曾用一个固定宽度的 iframe 包住应用来绕开这个限制，**后来放弃了** ——
> headless 下 `iframe.onload` 时序不可靠，经常不触发，拿不到数据等于没测
> （`legacy/tests/drop-scan.mjs` 头部写了这段结论）。
> 相比之下 `Emulation.setDeviceMetricsOverride` 会触发完整重排、
> 之后合成事件不再进处理器，也不能用。
> **要补窄屏测试，先想清楚用哪条路**，别直接抄 iframe 那套。

**但「触屏」和「窄屏」是两件事，别一起放弃。** 触屏只需要指针事件带上
`pointerType: 'touch'`，**在桌面视口下就能合成**，不需要真的窄：

```js
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, ... }] });
```

`browser-smoke.mjs` 第八节就是这么跑长按 / 提起 / 拖动排序的。三个坑：

- **必须给 Chrome 加 `--touch-events=enabled` 启动参数**，否则事件被静默丢掉
  （不报错，只是不生效 —— 最难查的那种）
- `maxTouchPoints` **只能是 1..16**，给 `0` 会被 CDP 挡下来，报的是
  「Touch points must be between 1 and 16」，看着像触摸点的问题其实是这个参数
- `Input.dispatchTouchEvent` **抬手也要带坐标**：`touchPoints: []` 在有些版本上
  被接受、有些版本报错，一律带上最后那个点

> 这条路证的是「指针管道通、手势逻辑对」，**不是**「真手指在真手机上顺手」。
> 真机手感仍然要人看。

**35. 解析器的规则顺序不能重排：重复必须在日期之前**

`domain/parse.ts` 的 `rulesOf()` 返回的数组顺序是有意义的，注释里写了原因：
**「每周一」如果不先被重复规则吃掉，会被后面的日期规则当成「周一」解析成某个具体日期。**

同理还有几处顺序敏感：

- **「重复」整组必须在「日期」整组之前。** `每` / `每周` / `每月` / `工作日` 都是前缀触发词。
- **`大后天` 必须排在 `后天` 前面**，否则先匹配到「后天」。
- **`下下周一` 必须排在 `下周一` 前面。**
- **完整日期必须在「N号/N日」之前**，否则 `15` 被单独吃掉。

规则靠**顺序 + `ctx.isolated` 双重把关**识别片段：
`ctx.isolated` 要求匹配片段**前后都是词边界**（前面是行首或空格，后面是行尾或空格），
用来避免「有三点要说明」里的「三点」被误判成时间 03:00。

> 口语里不带时段修饰的「3点」多半指下午，所以 `h < 8` 会自动 +12。
> **但只有「整段独立成词」时才这么做**（`if (mi === 0 && !ctx.isolated) return null`）；
> 带「半 / 刻 / 分」时信号足够强，不需要独立成词。

**36. 窄屏的负载文字要用 `shortLoad`，不要用完整时长**

月视图格子窄（53px 宽），完整文案「3小时45分」会**折成三行把日期数字挤扁**。
`D.shortLoad(mins)` 是专门给窄屏的：`225 → 3¾`、`60 → 1时`、`45 → 45分`。
只有宽屏才用完整的 `D.fmtDuration`。

**37. 改 nginx 配置在本机直接 cp，别 ssh 自己**

这台机器（`ubuntu`，`192.168.1.6`）**就是 nginx 与后端所在的服务器**，
工程目录也在本机。所以改 `deploy/schedule.conf` 后直接：

```bash
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

> **别写 `ssh nas`** —— `~/.ssh/config` 里没有 `nas` 这个别名
> （本机叫 `ubuntu` / `fn`），在本机上执行会报 `Could not resolve hostname nas`。

**38. 端口 25692 上如果有个手动起的进程，systemd 服务会静默重启循环**

表现是 `systemctl --user status` 里 `restart counter is at N`，
`journalctl` 里 `EADDRINUSE`。**排查后端时先看 25692 是谁占着。**
`ss -lptn 'sport = :25692'`。

**39. 探针里的 `waitFor` 表达式不能以换行开头（ASI 会把它变成裸 `return`）**

`evalJs` 把表达式包成 `(async () => { <表达式> })()`，`waitFor` 再在前面加
`return`。表达式要是从模板字符串的换行处开始：

```js
await waitFor(page, `
  [...document.querySelectorAll('[data-cal]')].some(…) ? 1 : null`, '…');
```

生成的代码就是 `return\n [ …`，**ASI 在 `return` 后面补一个分号** ——
整条表达式成了不可达代码，求值恒为 `undefined`，一直等到超时。
报错长这样：`等不到「…」，最后一次求值 = undefined`。看着像应用没反应，
其实探针自己写错了，而且**多行表达式（为了排版好看）几乎必然踩上**
（第「十」节就是这么假失败了两轮）。

> 已经在 `waitFor` 里 `expr.trim()` 掉了，别把这个 trim 当成多余的。
> 写多行模板时也别把 `? 1 : null` 拆到下一行 —— 那是另一个坑。

**40. 探针的合成点击必须连 `pointerdown` 一起补，`el.click()` 不算一次真点击**

这个应用的点击委托是 **pointerdown 驱动**的（长按状态机就挂在
`onPointerDown` 上），`el.click()` 只补一个 `click`，跟真手指/真鼠标走的
不是同一条路：

```js
el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', … }));
el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, pointerType: 'mouse', … }));
el.dispatchEvent(new MouseEvent('click', …));
```

> 第「十」节原来只写 `el.click()`，于是被第八节触屏拖拽留下的
> `lp.current.fired` 整下吃掉，断言报的是「提示里没点名是哪个集」——
> 指向的是提示的实现，而真正的问题在点击根本没进去。
>
> **这一条也顺带捉到一个真 bug**：那个标志的复位本来排在 `pointerDown` 的
> 鼠标 `return` 之后，鼠标点的那一刻不复位（触屏点有自己的 pointerdown，
> 所以只有鼠标这条中招）。验过它有牙：把复位挪到 `return` 之后重新构建，
> 恰好失败那两条（见四、14 的引用）。
>
> 反过来说，**「第一下被吃掉」这种症状先怀疑探针**：真手指的点击永远带
> pointerdown，而合成事件不带 —— 别急着去改产品代码。

> 这一段现在是 `clickEl(page, 表达式)` 一个函数（连同事件序列一起返回，
> 失败信息里就直接看得出点没点进去），别再在调用点手写一遍。

**41. `persist()` 有防抖，别在改动之后立刻读 localStorage**

`store.persist()` 是**防抖**的。所以「加一条任务 → 立刻读 localStorage 找它」
读到的还是**上一版**的盘子：界面上那一行已经在了、`outbox.length === 0`
也「成立」（读的是旧值，本来就是空的），只有任务是空的 —— 看起来像任务凭空
消失了（第「十一」节就这么假失败了一轮，失败信息还把人往「解析器改写了标题」
上引）。

等它落盘再读：

```js
const mine = await waitFor(page, `
  (() => {
    const t = Object.values(JSON.parse(localStorage.getItem('schedule-app-v4')).tasks)
      .find((x) => x.title === '…');
    return t ? { id: t.id, calId: t.calId } : null;
  })()
`, '新任务落盘');
```

> 要真值就走 DOM 或等轮询，**别把「读一次 localStorage」当成同步点**。
> 反过来说，凡是拿 localStorage 当断言的（第「十」节的降级、第「十一」节的
> 冲突记录），都套在 `waitFor` 里 —— 那才是它该有的用法。

**42. `waitFor` 只能放**表达式**，多语句要包一层 IIFE**

`waitFor` 把参数包成 `return <expr>`（见四、39），所以 `const t = …;` 这种
语句会直接报 `SyntaxError: Unexpected token 'const'`。要写多行就包一层：

```js
await waitFor(page, `(() => { const x = …; return x ? 1 : null; })()`, '…');
```

> `evalJs` 没有这个限制（它包的是 `(async () => { … })()`），
> 两个函数长得像、用法不一样。
> 顺带：`evalJs` 报异常时打的是 `exceptionDetails.exception.description`，
> 只打 `exceptionDetails.text` 的话每个异常都长成一句「Uncaught」，等于没说
> （这条也踩过）。

---

## 五、界面约定

**交互统一是「列表 → 详情 → 编辑」三段式**（用户 2026-10-05 裁决）。
任务一律走这条路：点行 → `drawer` 详情 → 从抽屉底部进编辑。

删除走应用内确认弹层（`useConfirm`），正文要写清连带后果。

**界面上不要出现「备忘录」「笔记本」「清单」的字样。** 三个模块已删除，
旧数据里的备忘录内容迁移时**直接被丢掉**（没有 `archive` 字段，见二）。

**脚本身份统一是「打卡」不是「习惯」。** `habits` 数组名保留（数据结构），
界面文案一律「打卡」，侧栏 `data-nav="habits"` 的 label 写「打卡」。

**深浅色只有 light / dark 两档**，存 `ui.theme`，顶栏切换。
**没有多套风格 / 色板** —— 那是账本项目的机制，本项目没有，别照抄。

**灰阶的取值是算出来的，不是挑出来的。** `--text` / `--text-2` / `--text-3`
三档，每一档对**每一种底色**（亮色最难的是 `--panel-3` `#f3f5fa`）都要 ≥ 4.5:1
（WCAG 1.4.3 正文）。这三档不是装饰色：`--text-2` / `--text-3` 在 10.5–12px 的
**有信息量**文字上用了 38 处（时间轴刻度、行内元信息、打卡连续天数…）。

> 旧值 `--text-3: #949bab` 只有 **2.79:1**，看着「淡雅」，实际读不清。
> 修的时候**必须按 L\* 感知亮度定档，不能按对比度比值** —— 比值不是线性感知，
> 按比值补到 4.5:1 会正好落在 `--text-2` 上，**三层灰当场塌成两层**。
> 现在的做法是把三档的 L\* 间距按原比例整体压进达标区间。
> `app/tests/contrast.mjs` 锁着这条（`node tests/contrast.mjs`，零依赖）。

**亮色的语义色与「快速添加」那组胶囊整体低于 4.5:1，暗色那一套全部达标。**
这是先天的、没改，脚本只报告不断言：

| 变量 | 用在哪 | 亮色 | 暗色 |
|---|---|---|---|
| `--warn` | 打卡连续天数 `.ci-streak` | **2.66** ✗✗ | 7.96 ✓ |
| `--ok` | 进度数字 `.sp-num b`（16px，不算大字） | **3.46** ✗ | 6.63 ✓ |
| `--chip-time-fg` | 快速添加的时间胶囊（11.5px） | **3.88** ✗ | 6.90 ✓ |
| `--danger` | 错误提示、危险按钮 | **4.02** ✗ | 5.56 ✓ |
| `--chip-rep-fg` | 重复胶囊 | **4.02** ✗ | 7.89 ✓ |
| `--chip-pri-fg` | 优先级胶囊 | **4.22** ✗ | 6.83 ✓ |
| `--primary` | 链接文字、主按钮 | **4.39** ✗ | 5.57 ✓ |

> 要修的时候注意 `--primary` / `--danger` **既当文字色、也当按钮底色配白字**，
> 两边的对比度要一起算 —— 只调一个方向会让另一种用法更糟。

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

---

## 六、给 AI 的硬约束

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

## 七、部署

```bash
cd app && npm run build          # 前端产物 → ../dist/，刷新即生效
```

改了后端才需要 `systemctl --user restart schedule-backend`。
**完整细节（nginx、systemd、备份、回滚、排障）在 [DEPLOY.md](DEPLOY.md)。**
