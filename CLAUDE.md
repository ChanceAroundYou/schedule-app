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
│   │   │   │                / parseDateText（「找日期」输入框专用，见四、35 末）
│   │   │   ├── parse.ts    自然语言解析（规则顺序敏感，见四、35）
│   │   │   ├── repeat.ts   重复推进 + seriesRootOf + 派生 id
│   │   │   ├── layout.ts   HOUR_H 等时间轴常量 + layoutOverlap
│   │   │   ├── model.ts    counts / liveTasks / dayLoad / 各种选择器
│   │   │   ├── merge.ts    逐字段 LWW 客户端侧合并 + findConflicts（冲突判定）
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
│   │   │   ├── ActSheet.tsx  长按操作层（触屏专用，在「提起后原地松手」时出现，见四、14）
│   │   │   ├── Settings.tsx  设置页：外观三轴 · 功能区自定义 · 数据备份 · 修改密码
│   │   │   ├── Auth.tsx    登录 / 注册（开放注册，无管理员）
│   │   │   ├── kit.tsx     Btn · IconBtn · useConfirm · ConfirmProvider · ToastHost
│   │   │   ├── dnd.ts      **让位洞**拖拽层 + 触屏那条 pointer 通路（最易踩坑的一块，见四、8 与四、14）
│   │   │   ├── Clock.tsx   12 小时制时间转盘（快速添加里那个钟表按钮）
│   │   │   ├── dragState.ts  模块级「正在拖」标志，给 sync 守卫用
│   │   │   ├── hooks.ts    useStoreState / useScopedState / useIsNarrow / useOnline /
│   │   │   │                useOutsideClose / useKeyboardInset / useFocusTrap
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
│       ├── browser-smoke.mjs  新界面照一遍：注册 → 切集 → 改名 → 接受邀请 → 触屏/鼠标拖拽 → 断网
│       └── contrast.mjs       色板 78 对 ≥4.5:1 · 控件描边 8 对 ≥3:1 · 变量名写错 / 兜底值扫描
│
├── server/                 后端（Node 22，**零 npm 依赖**）
│   ├── server.js           路由表 + 处理器 + 鉴权中间件
│   ├── lib/db.js           node:sqlite：建表 / field_state / changes / users / cals
│   ├── lib/auth.js         scrypt 哈希 + 自签 JWT + 用户名口令校验
│   ├── lib/sync.js         逐字段 LWW + 快照 + 全量游标增量 + 按集鉴权
│   ├── lib/calendars.js    日程集：建 / 改名 / 删 / 退出 + 成员与角色
│   ├── lib/invites.js      邀请：发出 → 待接受 → 接受 / 谢绝 / 撤回
│   ├── lib/ratelimit.js    定点窗口限速（登录 / 注册 / 邀请）
│   └── tests/
│       ├── api.test.js        31 条接口用例
│       └── smoke-share.mjs    真走网络：两个人共用一个集的全流程
│
├── dist/                   构建产物（生成物，勿手改；nginx 只伺服这里）
├── deploy/                 nginx conf + systemd 单元的本地副本
├── legacy/                 旧版纯静态应用，**冻结**（回滚用，见 DEPLOY.md 七）
├── docs/                   接口.md · 重构路线.md
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
```

线上那份由 `systemctl --user` 管，见 [DEPLOY.md](DEPLOY.md) 2.4。

### 测试

```bash
cd app          && npm test                     # 94 条（node --test，跑 *.test.ts）
cd app          && npm run typecheck
cd app          && node tests/contrast.mjs      # 正文 78 对 ≥4.5 · 描边 8 对 ≥3 · 变量名两段，零依赖
node server/tests/api.test.js                   # 31 条接口
node server/tests/smoke-share.mjs               # 两个人共用一个集，真走网络
cd app          && node tests/browser-smoke.mjs   # 177 条（无头 Chrome + CDP，零 npm 依赖）
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
离线小标 → **把静态服务关掉还能打开** → 无障碍点名 → **方向键微调时间轴把手** →
**软键盘变量 --kb 两端接没接上** → **抽屉的 dialog 语义与焦点圈**。
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

> 第「十四」节（2026-10-06）专测**时间轴上下沿的键盘通路**：
> `Tab` 能不能够到那两个把手、方向键有没有按 `data-act` 接到对的那一端。
> 用 CDP 的 `Input.dispatchKeyEvent` 按**真实焦点**派发（见「四、44」），
> 不是自己在页面里造一个 target。算式本身（15 分钟一档、上沿固定底边）
> 在 `domain.test.ts` 的 `nudgeEdge` 用例里，这一节只管接线。
>
> 第「十五」节专测**软键盘避让的管道**：`useKeyboardInset` 有没有写 `--kb`、
> 固定浮层有没有读它。真软键盘无头里造不出来，所以只验这两端（同触屏那条的限度）。
> 写这两节时连踩了三个**伪装成产品 bug 的探针坑**，见「四、43」。
>
> 第「十六」节（2026-10-06）专测**语义与焦点**：抽屉是不是 `[role=dialog]`、
> 焦点开时进不进面板（要落在面板本身，不是第一个输入框）、Tab 圈不圈得住
> （从**最后一个**可聚焦元素按，才证得了）、关掉还回不还回原处；
> 侧栏的 `aria-current`、找日期的 `aria-expanded`；以及 `prefers-reduced-motion`
> 关掉过渡但放过加载圈。验过它有牙（三处一起改坏，三条当场红）。
> 四个坑都在「四、45」：`[role=dialog]` 的歧义、上一节留着的抽屉、
> `getComputedStyle` 的 `1e-05s`。
>
> 第「十七」节（2026-10-06）补的是**此前一条断言都没有的三样**：找日期的
> **文本输入**（不是点格子）、快速添加里那个 12 小时制转盘、侧栏跨组拖拽重排。
> 转盘那一节顺带量出表盘在弹层里偏右 2px（`.cp-face` 写死 246px，而
> `.clock-pop` 的 274px 扣掉边框和内边距只剩 242px，`margin: 0 auto` 塌成 0），
> 见「五、界面约定」里那条宽度。
> 验过它有牙：把 `parseDateText` 里裸周几那句 `if (!m[1] && d < today)` 改坏、
> 重新构建，只有「裸周几落在将来」那一条红（差 -1 天）。
> 三个坑都在「四、46」。
>
> 第「十七」节 2026-10-07 又扩了三样（快速添加那三件改动的接线）：
> 时钟按钮点下去**先出日期面板**（42 格、待办箱默认 0 格高亮）、
> 选完日期才出转盘、胶囊上日期和时间**同时在**、选的那天真的落库；
> **占位符在「今天」和「待办箱」两页完全一样**；
> 以及窄屏的**浮动 `+` 号**（在、默认收起、点开、再点收起）。
> 窄屏那条靠 `Page.addScriptToEvaluateOnNewDocument` 里一个 `matchMedia` 的
> Proxy 强行把 `(max-width: 900px)` 判成 true（`sessionStorage.__forceNarrow === '0'`
> 时放行真实值），绕开无头 Chrome 那个 526px 的下限（见四、34）。
> 写这几条时踩到 `evalJs` 少了 `return`（见四、39），三条假红。

`app/tests/smoke.mjs` 是更早那份冒烟脚本，头部写死了本机 Chromium 路径
（`CHROME` 可覆盖，默认 `/home/xiaokubao/.local/bin/chromium`）。

其余探针坑见「四、33」。

> **旧版根目录那个 `package.json`（`npm test` 空转的那个）已经没有了。**
> 现在根目录没有 `package.json`，`npm test` 只在 `app/` 里跑真测试。

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

> **浮层的宽度要按「内容盒」算，不是按外框算。** `* { box-sizing: border-box }`
> （`legacy.css` 第 139 行）意味着 `width` 里已经扣掉了边框和内边距。
> 时间转盘 `.clock-pop` 原先写 274px，扣掉两条 1px 边框和左右各 15px 内边距
> 只剩 242px，而里面的 `.cp-face` 是**写死的 246px**（`C = 123` 是它的一半，
> 见 `ui/Clock.tsx`）—— 表盘比内容盒宽 4px，`margin: 0 auto` 塌成 0，
> 整个表盘偏右 2px。现在写 278px，内容盒恰好 246。
> **凡是「里面有个写死宽度的东西」的浮层都要这么对一遍**，别只量外框。

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

**23. 侧栏顺序存在 `ui.navOrder` / `ui.navBottom`，`normalizeUi` 必须区分 undefined 与空数组**

状态存 `ui.navOrder`（全局顺序）+ `ui.navBottom`（哪些归底部那一组）。
底部组在窄屏是底部标签栏之外的「更多」抽屉，宽屏是侧栏的下半区。

> ⚠️ **老版本的标题是「侧栏顺序可拖动」，那是过期说法。** React 重写之后
> `ui.navOrder` / `ui.navBottom` **一度是死数据**：`ui/Shell.tsx` 还在读它们，
> 但全项目**没有任何调用点写它们**（`grep -rn 'navBottom' app/src` 只有类型、
> 默认值、`normalizeUi` 和读取处）。所以「拖过一次顺序就记住了」在那一版是假的 ——
> 看到的永远是默认顺序。写入方在 2026-10-06 的「功能区自定义」里补回，
> 入口在**设置页**（不复用 `ui/dnd.ts`，那套是给时间轴与让位洞用的）。

处理在 `domain/model.ts` 的 `normalizeUi()`：

> **`navBottom` 不能用「空则默认 `['trash']`」的写法** —— 那会把用户主动拖出底部的
> 垃圾箱又塞回去。必须区分「从未设置（`undefined` / 不是数组）→ 给默认」
> 与「空数组 → 用户有意为之，原样保留」。
> 代码里就是 `bottom === null ? ['trash'] : bottom`，`domain.test.ts` 有用例锁着。

其他坑：侧栏 active 高亮要用统一的 `$$('.nav-item')` 取，不能分开写 `#nav`
与 `#navBottom`。（旧版还有一条「`dragend` 后补一次 `click`，用 `navJustDragged`
吞掉」—— 那个标志在新版代码里**不存在**，别照着找。）

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

> **「找日期」那个输入框是另一套解析器，裸周几的口径必须和 `parse()` 一致。**
> `domain/date.ts` 的 `parseDateText(raw, baseIso, todayIso?)` 是给「找日期」输入框
> 专用的：它只解析一个日期片段，认得比 `parse()` 深（`1015`、`2026-10`、
> `上个月` 都认），而且**年份基准是面板所在的月份**，不是今天 —— 12 月翻到面板
> 显示次年 1 月时输入「1月5日」，要的是明年。
>
> 两处**必须一致**的是裸周几：`parse.ts` 里那条日期规则是
> `if (d < todayIso) d = D.addDays(d, 7)`，`parseDateText` 里也得有同一句。
> 曾经没有 —— 于是同一句「周三」，在任务标题里跳到下周三、在找日期框里跳到
> **两天前**。改这块时两个解析器要一起看，`domain.test.ts` 有一条用例
> 直接拿 `parse()` 的结果和 `parseDateText()` 比，口径一歪就红。

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

> **同一个包装的另一半：`evalJs` 里的表达式必须自己写 `return`。**
> `waitFor` 会替你补 `return`，`evalJs` **不会** —— 它只是
> `(async () => { <表达式> })()`，光写一个表达式等于算完就丢，求值恒为
> `undefined`。断言写成
> ``ok(await evalJs(page, `!!document.querySelector('.fast-fab')`), …)``
> 就永远是红的，而页面其实好好的（2026-10-07 加浮动 + 号时三条假红，
> 诊断行里 `fab: true` 和那条 FAIL 摆在一起才看破）。
> **规矩：`evalJs` 一律写 `return …;`，`waitFor` 一律不写。**

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

**43. 写探针时踩到的三个（都会伪装成「应用坏了」）**

2026-10-06 加「方向键微调时间轴上下沿」那一节时，连着假失败三轮，
每一轮**指向的都是产品代码，实际全是探针自己的错**：

- **在待办箱里快速添加「9:00 开会」得到的是「有时间、没日期」的任务。**
  `quickDefaults()` 对 `nav==='inbox'` 返回 `date: null`，而时间轴按 `date` 挑 → 这条
  任何日视图都不画方块，探针在「等方块」上超时，看着像时间轴渲染坏了。
  要造一条有时间轴方块的任务，就得在**日程页**（那边 `quickDefaults` 给的是
  `ui.cursor`）加，或者写字面日期。
- **`.ev-resize` 会先命中上沿**（上沿的 class 是 `ev-resize ev-resize-top`，
  DOM 里排在前面）。断言名写着「下沿」、实际查的是上沿 —— 两者形状一样，
  于是照样绿。要下沿就用 `.ev-resize:not(.ev-resize-top)`。
- **基准值不能刚保存就读 localStorage**（四、41 的翻版）。新建的任务在
  `persist()` 防抖落盘之前读不到，`undefined + 15` 是 `NaN`，
  于是「按了键没反应」。这次是靠失败信息里那句 `目标时长 undefined` 定位的 ——
  **诊断行要带原始值，不要只写「等不到」**。

> 共同点：**症状全都指向产品，根因全在探针**。上一节（四、40）那段
> 「先怀疑探针」在这里又应验了三次。加断言时顺手把关键中间量打进失败信息里，
> 能省掉一整轮 4 分钟的复跑。

**44. 合成方向键要用 CDP 的 `Input.dispatchKeyEvent`**

`el.dispatchEvent(new KeyboardEvent('keydown', …))` 也能让处理器跑起来，
但那样 `target` 是**我们自己摆上去的**：控件要是压根拿不到焦点（比如漏了
`tabIndex`），断言照样通过。走 CDP 的 `Input.dispatchKeyEvent` 则按**真实焦点**
派发 —— 验过它有牙：把下沿那句 `tabIndex={0}` 摘掉重跑，焦点落到 `BODY`，
「把手真能拿到焦点」当场失败。

```js
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
```

`keyDown` 和 `rawKeyDown` 都进得来（实测同效），`keyUp` 要跟着发一个。

**45. 探针里的 `[role="dialog"]` 现在是个歧义选择器**

详情抽屉也变成 `role="dialog"` 之后，第十六节原来那句
`waitFor('[role="dialog"]' 存在)` 会**先命中抽屉**（它本来就开着）：
「确认浮层打开」当场假通过，结尾那句「等它关掉」则永远等不到 —— 报的是
「等不到确认浮层关掉」，指向的是 Sheet 的实现，而真正的问题在选择器。

Sheet 是 portal 到 body 的，用 `body > div > div[role="dialog"]`；
或者按文字筛。**加了一个 `role` 就要回头看看有没有别的选择器被它带偏。**

同一条里还有两个同类坑：

- **上一节把抽屉留在打开状态，下一节点一行不会重挂组件**，靠 `[id]` 触发的
  focus-in `useEffect` 根本不会跑 —— 那一节要验的东西会全体落空
  （症状：焦点读到的是快速添加框、末尾「还回原处」等不到）。
  断言的**前置条件**也要自己造，别假设上一节给你留了个干净盘子。
- **`getComputedStyle` 回的是序列化后的值**：CSS 里写 `0.01ms`，
  它在 Chrome 里读出来是 `1e-05s`。比字符串会得到假失败，
  要按单位解析成秒再比大小。

**46. 探针伺服的是 `dist/`，不是源码**

`serveDist()` 读的是 `../dist`，所以**改完前端不 `npm run build` 就等于没改**：
第十七节第一次跑出来的「裸周几落在将来」是绿的，但那时跑的是上一轮的产物 ——
它证的是接线，不是刚修的那个 bug。**改完前端先构建，再跑探针。**

同一条里还有两个同类坑：

- **`dragover` 是连续事件，React 会批处理**。在同一个 `evalJs` 里
  `dispatchEvent(dragover)` 紧接着读 DOM，读到的是**上一帧**的让位线
  （症状：`no-ins`，看着像事件没进处理器）。要等一拍再读。
- **断言别写死「应该是什么」，要写「和刚才量到的一致」**。侧栏拖拽那一节
  我写的是 `navBottom === ['habits']`，而正确值是 `['trash','habits']`
  —— 垃圾箱**本来就该**留在底部组（`navBottom` 是「哪些归底部」，
  不是「底部组里只有谁」）。改成和 DOM 里量到的顺序比，才既对又不脆。

---

## 五、界面约定

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
顶栏**照旧不许加 `position` / `z-index` / `sticky`**（见四、13）。

**2. 日程页的控件搬进副header**（`ui/Shell.tsx` 的 `CalSubheader`）：
`‹ › / 今天 / 日期长文本 / 找日期` + `日|周|月`，只在 `nav === 'calendar'`
时渲染，紧贴顶栏下面一行（`.cal-subhead`）。

> **日期长文本只在副header 出现一次。** 顶栏原先也写一遍，于是桌面日程页
> 「2026年10月7日 周三」在相邻两行各报一次。粒度跟着视图走：
> 日 = 某天 · 周 = 这一周的起止 · 月 = 第 N 周。
> `browser-smoke.mjs` 第十七节数着 `.date-range` 的个数（宽屏日程页应当 == 1）。

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

### 快速添加：窄屏一个浮动 `+`，日期 / 时间分两层（2026-10-07）

**窄屏（≤900px）默认收起成右下角一个浮动 `+`，点开才展开横条、再点收起（图标变 `×`）。**
宽屏常驻展开 —— 桌面有地方，多一次点击只是碍事。状态是 `QuickAdd` 里的
`expanded = useState(!narrow)`，**不落盘**：这是「这一次怎么用」，不是用户偏好。
`narrow` 用 `useIsNarrow()` 同步初始化，所以首帧就是对的，不会闪一下。

- `.fast-fab` 的 `z-index` 是 **39**：要压住正文，但**必须低于抽屉遮罩的 40** ——
  抽屉打开时它该被罩住，而不是浮在遮罩上还能点。底部偏移是
  `calc(56px + env(safe-area-inset-bottom, 0px) + 12px)`（56px = 标签栏高）。
- 窄屏展开时横条加了 `padding-right: 62px` 给 FAB 让位，别把时钟按钮盖住。
- 「N」快捷键在窄屏下**先展开再聚焦**。收起的横条是 `display:none`，聚焦不上去，
  所以展开后要等一次 effect（`focusOnExpand` ref）再 `focus()`。
- 收起的横条靠 `hidden` 属性藏（Tailwind 4 preflight 的
  `[hidden] { display: none !important }` 压得住 `legacy.css` 里没分层的
  `.fast-add { display: flex }`）。**别改成自己加一个 `display:none` 的类** ——
  那就得跟层叠顺序再斗一次（见四、24）。

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

`app/tests/contrast.mjs` 四段都在锁：① 78 对「文字 on 真会落上去的底色」≥ 4.5:1；
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
失败信息指错地方（这个探针里栽过一次，见四、40）。

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
  （必须写在 `legacy.css` 里：Tailwind 的 `outline-none` 在 `@layer` 里，压不过它，见四、27。）

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

## 六、给 AI 的硬约束

1. **后端不许引 npm 依赖。** 只用 Node 标准库（`node:http` / `node:sqlite` /
   `node:crypto`）。这是「十年后 `node server.js` 还能跑」的代价换来的。
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
