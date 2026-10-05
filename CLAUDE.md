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
│   ├── public/             icon.svg · manifest.json（原样拷进 dist/）
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
│   │   │   ├── merge.ts    逐字段 LWW 客户端侧合并
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
│   │   │   ├── Drawer.tsx  抽屉（详情 + 编辑）
│   │   │   ├── ActSheet.tsx  长按操作层（触屏专用）
│   │   │   ├── Auth.tsx    登录 / 建首个账户
│   │   │   ├── kit.tsx     Btn · IconBtn · useConfirm · ConfirmProvider · ToastHost
│   │   │   ├── dnd.ts      **让位洞**拖拽层（最易踩坑的一块，见四、8）
│   │   │   ├── dragState.ts  模块级「正在拖」标志，给 sync 守卫用
│   │   │   ├── hooks.ts    useStoreState / useIsNarrow / useOutsideClose / useDebounced
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
│   └── tests/smoke.mjs     端到端冒烟（无头 Chromium + CDP，零 npm 依赖）
│
├── server/                 后端（Node 22，**零 npm 依赖**）
│   ├── server.js           路由表 + 处理器 + 鉴权中间件
│   ├── lib/db.js           node:sqlite：建表 / field_state / change_log / users
│   ├── lib/auth.js         scrypt 哈希 + 自签 JWT + 用户名口令校验
│   ├── lib/sync.js         逐字段 LWW + 快照 + 游标增量
│   └── tests/api.test.js   19 条接口用例
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
4. **长按操作层**（触屏）、**快捷键**、**导出 / 导入**。

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
  ui: UiPrefs,                       // nav / view / cursor / theme / search /
                                     // navOrder / navBottom / tdoneOpen
  cursor: number,                    // 已拉到的服务端序号
  outbox: Op[],                      // 待推送的 op
  lastError: string | null,          // 上次同步的报错，给顶栏那个小标用
  clockBlocked: string[],            // 被服务器退回但值得重试的 opId（时钟不对那一类）
  syncing: boolean,                  // 瞬时状态，**不落盘**（load 时一律重置为 false）
}

interface Task {
  id, title, note,
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
cd app    && npm test        # 47 条（node --test，跑 *.test.ts）
cd app    && npm run typecheck
node server/tests/api.test.js   # 19 条
```

端到端冒烟（无头 Chromium + CDP，零 npm 依赖）：

```bash
node server/server.js                                   # 终端 1（或线上后端）
cd app && npm run preview                               # 终端 2
node app/tests/smoke.mjs                                # 终端 3
```

**脚本头部写死了本机 Chromium 路径**（`CHROME` 环境变量可覆盖，
默认 `/home/xiaokubao/.local/bin/chromium`）。会真的注册一个账户 ——
**打线上跑完必须清库**，否则你的账户就不是管理员了（见 DEPLOY.md 6.2）。

其余探针坑见「四、33」。

> **旧版根目录那个 `package.json`（`npm test` 空转的那个）已经没有了。**
> 现在根目录没有 `package.json`，`npm test` 只在 `app/` 里跑真测试。

---

## 四、踩过的坑（改代码前先看这里）

### 同步 / 数据

**1. 旧版 Service Worker 会把用户永远钉在旧界面上**

旧版注册过 `sw.js`（`CACHE = 'schedule-v12'`），缓存里有**旧版 index.html**。
网络优先，所以通常刷新就拿到新页面；但离线 / 抖动时它会回旧 HTML，
那份 HTML 又去加载 `app.js` / `views.js`，用户看到的是上一版界面，
而且「怎么刷新都不变」。

修法在 `app/src/main.tsx` 的 `escapeLegacyServiceWorker()`：注销所有 SW
（只动 scope 含 `/schedule/` 的）、删掉所有 `schedule-*` 缓存，然后重载一次。

> **那个重载必须带 `sessionStorage` 标记。** 没有标记的话，只要每次都能
> 「清理成功」就会无限刷新 —— 无头测试里最容易把浏览器挂死的一类 bug。

**2. 拖动期间不要拉同步**

远端变更落地 → React 重绘 → 让位用的 `transform` 和占位洞全部重建 →
用户看到的是「拖到一半整个列表弹回原位」。

修法在**唯一的卡口**上：`sync/engine.ts` 的 `syncNow()` 开头
`if (isDragging()) return;`。拖动只有几秒，跳过这一轮没有代价 ——
outbox 还在，下一个轮询或下一次本地改动自然会把它推上去。

**3. LWW 是逐字段的，不是整条**

整条任务做 LWW：手机改标题、桌面改日期，后同步的那方会把对方**整个字段集**
覆盖掉，用户看到「我改的东西凭空没了」。逐字段的代码量几乎一样，但两个改动都留得住。

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
| `.drag-muted` | 让位开始后被拖元素淡出 | 在用 |
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

**14. 触屏没有 hover，也没有 HTML5 拖拽**

- `@media (hover: none)` 处理 hover 才显形的元素（拖拽抓手、箭头、背景高亮）
- 排序 / 改期靠**长按 480ms 弹操作层**（`#actSheet`），`LONG_PRESS_MS = 480`。
  `pointerdown` 计时，`pointermove` / `pointerup` / `pointercancel` / `pointerleave` 取消，
  **只在 `pointerType !== 'mouse'` 时启用**（鼠标继续走拖拽）
- `longPressFired` 标志 + capture 阶段 click 拦截：长按生效后抬手那一下
  不会再顺带打开抽屉
- **动作值用无歧义前缀**：`dur60` 不是 `d60` —— 后者与 `del` / `date` 撞，
  靠 `+slice(1) > 0` 猜必然误伤。改动作值时按 `/^dur(\d+)$/` 匹配
- 窄屏下显式 `dragstart` → `preventDefault()`，避免某些移动浏览器模拟出半截行为

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

**34. 无头 Chrome 有最小窗口宽度约 526px，窄屏目前没有被自动化覆盖**

`--window-size=390` 实测 `innerWidth` 是 526，量不到真手机宽度，截图也会被裁。

**现在的 `app/tests/smoke.mjs` 只跑一个 1440×900 的桌面视口**，
窄屏 / 触屏路径（≤900px 的标签栏、长按操作层、`@media (hover: none)`）
**没有自动化覆盖，改那边只能靠手工在真机上看**。

> 旧版曾用一个固定宽度的 iframe 包住应用来绕开这个限制，**后来放弃了** ——
> headless 下 `iframe.onload` 时序不可靠，经常不触发，拿不到数据等于没测
> （`legacy/tests/drop-scan.mjs` 头部写了这段结论）。
> 相比之下 `Emulation.setDeviceMetricsOverride` 会触发完整重排、
> 之后合成事件不再进处理器，也不能用。
> **要补窄屏测试，先想清楚用哪条路**，别直接抄 iframe 那套。

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

**图标一律 lucide，零 emoji。** 弹层一律应用内，零原生 `confirm` / `alert`。

**金额相关一律不适用**（本项目没有金额字段）。

**没有登录？有登录。** 但**没有密码找回、没有邮箱、没有第三方登录** ——
用户名 + 密码，第一个注册的是管理员，之后由管理员加人。
别把账本那套鉴权搬过来（那边是单密码 `auth.json`，这里是用户表 + JWT）。

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

---

## 七、部署

```bash
cd app && npm run build          # 前端产物 → ../dist/，刷新即生效
```

改了后端才需要 `systemctl --user restart schedule-backend`。
**完整细节（nginx、systemd、备份、回滚、排障）在 [DEPLOY.md](DEPLOY.md)。**
