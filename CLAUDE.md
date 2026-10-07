# 日程清单

个人用的任务与打卡网页。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
**前后端分离**：React 前端 + 自写 Node 后端 + SQLite，数据在服务器上。

| 文件 | 读者 | 内容 |
|---|---|---|
| [README.md](README.md) | 人 | 网址、怎么用、数据在哪、日常命令 |
| `CLAUDE.md` | AI 编码助手 | **本文 —— 往哪走**：结构、数据模型不变量、界面硬规则、最容易翻车的十条 |
| [docs/业务模型.md](docs/业务模型.md) | AI 编码助手 | 完整字段表、重复规则、逾期、冲突提示 |
| [docs/界面约定.md](docs/界面约定.md) | AI 编码助手 | 顶栏 / 周视图 / 快速添加 / 软键盘 各功能的约定 |
| [docs/踩坑.md](docs/踩坑.md) | AI 编码助手 | **改代码前先读**：40 条坑，一条一条都是约束 |
| [docs/测试.md](docs/测试.md) | AI 编码助手 | 怎么验：跑哪些测试、每个探针节在验什么 |
| [DEPLOY.md](DEPLOY.md) | 人 + AI | nginx 怎么操作、conf 怎么写、发布流程、回滚 |
| [docs/接口.md](docs/接口.md) | 人 + AI | HTTP 接口一览 |
| [docs/重构路线.md](docs/重构路线.md) | 人 + AI | 2026-10-06 这次重写的决策记录 |

**改代码前先读 [docs/踩坑.md](docs/踩坑.md) 和「三、界面约定」**；动某个功能前先读
[docs/界面约定.md](docs/界面约定.md) 里对应那一节。改 nginx / 发布前读 [DEPLOY.md](DEPLOY.md)。

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
│                          业务模型.md · 界面约定.md
├── .gitattributes          行尾一律锁成 LF，压过各机器的 core.autocrlf（见踩坑 36） · 踩坑.md · 测试.md
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

### 怎么跑起来

```bash
cd app && npm run dev            # Vite :5199，/api 自动代理到 127.0.0.1:25692
node server/server.js            # 后端 :25692，数据落 server/data/
SCHEDULE_DATA_DIR=/tmp/x node server/server.js   # 换数据目录（跑测试时用）
cd app && npm run build          # tsc -b && vite build → ../dist/
```

> **`dev` / `preview` 都占 5199，别同时开。** `preview` 用的是 `vite.config.ts` 里
> **另一段** `preview.proxy` —— 只写 `server.proxy` 的话，预览里所有 `/api` 都 404，
> 看起来像「登录不上」。跑测试见 [docs/测试.md](docs/测试.md)。

**依赖装在「本机磁盘」，不在共享盘**（CIFS 上成千上万个小文件正是踩坑 21 那个丢文件
风险）。靠工程根目录一个软链接指过去：

```bash
ln -s /home/xiaokubao/.local/share/schedule-deps/node_modules ./node_modules
```

> **软链，不是 `NODE_PATH`。** 两种都行，实际用的是软链 —— 它**不需要** systemd 那条
> Environment，也不挑进程从哪个目录起。`node_modules` 在 `.gitignore` 里，
> **每份 checkout 都得自己补一次**。缺了它 AI 页报「依赖没装好」，但服务照常起得来
> （`server/lib/ai/index.js` 是惰性 import）。装法见 [DEPLOY.md](DEPLOY.md) 的「依赖」。

**前端依赖不另装**——直接软链主仓库那份（主仓库的 `app/node_modules` 是装好的）：

```bash
ln -s /home/xiaokubao/family/星星包/coding/日程管理/app/node_modules app/node_modules
```

> 在 worktree 的 `app/` 里执行。后端那份（`schedule-deps`）装在本机磁盘，
> 前端这份直接复用主仓库的，**不重复安装**。

---

## 二、业务模型（**最要紧的部分**）

> 完整字段表、重复规则细节、逾期细节、冲突提示 → [docs/业务模型.md](docs/业务模型.md)。
> 这里只放**不能破的不变量**。

### 工具分工：这是一个纯任务管理应用

用户既定：滴答清单位 = 有日期 / 要行动的任务；系统笔记 = 长篇幅记录；
系统备忘录负一屏 = 无任务属性的提示。**本项目不做长篇幅记录。**

备忘录 / 清单（lists）/ 笔记本（notebooks）三个模块已整体删除。
**新版的迁移是「丢掉」，不是「归档」** —— 旧版会把它们折进一个 `archive` 字段
转存到 `schedule-app-notes-archive`，新版**没有 `archive` 字段、也不写那个 key**。
`ui.nav === 'notes'` 会被 `normalizeUi()` 兜回 `'today'`。**别再加回来。**

### 数据结构：六条不能破的

1. `tasks` / `habits` 是**按 id 索引的对象**，不是数组。
2. `calId` 是**主键的一部分**，不是可同步字段（和 `_ts` / `_dev` 一样只存在本地）。
   所以**把任务从一个集挪到另一个集 = 在目标集新建一条 + 在源集留一个墓碑**，
   而不是改一个字段。
3. **删除是墓碑**：`deleted = true` 让别的设备知道「要删」；`purged = true` 才在
   任何地方都看不见（垃圾箱里也没有）。
4. **三态各自独立**：未定时（`time===null`）· 未定日期（`date===null`）·
   已完成但仍占时间段（`done && time`，灰显留在时间轴上）。
5. **待办箱 = `date === null` 的未完成任务**。未定时是另一回事：`date` 有、`time` 为空。
6. **任务与打卡是两个独立模块**，互不混入：任务走 `tasks`、打卡走 `habits`，
   `habits` 的 `log` 是按日期的稀疏映射，没有 `date` / `time` / `duration` 字段。

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

**邀请是两段式的**，对方**接受后才生效**：`pending → accepted | declined | revoked`。
发邀请时按用户名找目标（找不到就 404，别提示「这个名字存在吗」），
不能邀请自己，已经在集里的人不能再邀请。同一个「集 + 人」只会有一条 pending。

### 同步：一个全局游标，不是每个集一个

`changes.seq` 是**全局单调**的自增主键，客户端只存一个 `cursor`；
拉的时候服务端按 `cal_id IN (我的集)` 过滤。省掉了「每个集各自一个游标」那张表，
代价是一个必须处理的坑：

> **新加入一个集时，那个集的历史变更全在游标后面。** 游标表达的是「我已经看到
> 全世界第几号了」，加入之前那个集的历史你早就跳过去了，光靠增量**永远拉不到**。
> 所以客户端一旦在响应里看到自己不认识的 `calId`，就**再要一次全量快照**
> （`sync/engine.ts` 的 `syncNow()` 里那段 `known` 判断）。

`POST /api/sync` **一次调用同时推和拉**，而且服务端**先落盘再取数** —— 返回的快照
已经含本批 op 合并后的结果。分成两次请求会拿到一个慢半拍的快照，客户端再合并回来
就把自己的写入盖掉了。

**日程集 / 成员 / 邀请走普通 REST，不走 LWW 同步引擎。** 它们是「关系」不是「字段」，
用时间戳定胜负没有意义。

**LWW 是逐字段的，不是整条**（见[踩坑 3](docs/踩坑.md)）：整条做 LWW 会让后同步的
那方把对方整个字段集覆盖掉。同字段两边都改过时，抽屉里会多一条只读提示 ——
提示本身不改数据，只是把判决结果说出来。

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
   > **不用 pi 的 `beforeToolCall` 拦。** `block` 会产生一个**错误工具结果**，
   > 模型会以为工具坏了、换个说法反复重试。真正的强制是**结构性**的 ——
   > 写工具根本没有写的能力。
2. 提案按 **`toolCallId`** 关联到 assistant 消息（**不按执行顺序**：pi 默认并行
   执行同一轮的工具），存进 `ai_messages.proposals`，所以刷新后卡片还在。
3. `POST /api/ai/confirm` 是**唯一真正落库的地方**（`lib/ai/confirm.js`）。
   它**只信 id 不信参数**：按 id 从库里读回提案，**重查一遍权限**
   （生成到确认之间用户可能被降级 / 被移出），再走 `sync.applyOps`。
   信客户端回传的 args 等于把权限判断交给浏览器。

**几个具体约定**：

- 确认时的时间戳走 `confirm.js` 的 `nextTs()`（`max(Date.now(), lastTs+1)`）——
  同一毫秒的两条 op 比较键完全相同，后一条会白写。
- 重复任务**拒绝**标完成：推进逻辑在客户端的 `repeatAdvance()` 里，服务端不复制一份。
- 软删除带 `trashFrom: 'AI'`，垃圾箱那行看得出是 AI 干的。
- `lib/ai/confirm.js` 是**CJS、直接 require**，不走 `ai/index.js` 那条惰性 import：
  确认是纯数据库操作，一条都不碰 pi。依赖没装好时，用户最需要的恰恰是把已经
  排好的改动确认掉。
- 界面上的动作条文案（「正在查 10月7日的安排」）**写死在 `domain/ai.ts` 里**，
  不让模型自己说 —— 那是给用户看的确定性提示。

**密钥**：Base URL / 模型 / API key 由用户在设置浮层里填，存服务器 `ai_settings`，
**只回 `hasKey: true/false`，绝不回显**。`PUT` 时 `apiKey` 字段省略 = 保留原值、
传空串 = 清空 —— 这个三态必须保住，否则一打开一保存就把 key 抹了。

**没有 seed、也没有「演示模型」。** 模型来源是本机或用户自填的 OpenAI 兼容端点。

### 重复规则

- **防死循环的判据是「必须往前走」，不是一个次数上限。** 曾经写的是 `guard < 800`，
  被证明是错的：一条 2020 年起的「每天」任务需要 2400+ 步才能补到今天。
  现在的循环条件是 `while (next && next < today && next > cursor)`。
  **别再把它换回一个魔法数字。**
- **重复实例的 id 是派生的**：`instanceId(根, 发生日)` = `` `${根}#${发生日}` ``。
  两台设备离线各自推进同一系列，会**派生出同一个 id**，同步时合并成一条而不是翻倍。
  这是整个同步模型里最要紧的一条不变量。

### 逾期

`counts().overdue` 是**唯一口径**：`!done && date && date < today`。
`counts().today` 只算当天，**不包含逾期** —— 2026-10-05 明确拆开，
之前混在一起导致同一任务在两个徽标里各数一次。

---

## 三、界面约定（**跨切面的硬规则**）

> 各功能（顶栏 / 周视图 / 快速添加 / 软键盘避让）自己的约定 → [docs/界面约定.md](docs/界面约定.md)。
> 这里放的是**不管动哪个功能都得守**的几条。

**交互统一是「列表 → 详情 → 编辑」三段式**（用户 2026-10-05 裁决）。
任务一律走这条路：点行 → `drawer` 详情 → 从抽屉底部进编辑。
删除走应用内确认弹层（`useConfirm`），正文要写清连带后果。

**界面上不要出现「备忘录」「笔记本」「清单」的字样。** 三个模块已删除。
**脚本身份统一是「打卡」不是「习惯」。** `habits` 数组名保留（数据结构），
界面文案一律「打卡」。

**深浅色只有 light / dark 两档**，存 `ui.theme`。**风格有三档**（soft / flat / notion），
存 `ui.style`，靠 `documentElement` 上的 `data-style` + `legacy.css` 令牌块。
**色板没有** —— 那是账本项目的机制，别照抄。

### 变量名不许写错，也不许给兜底值

`.tsx` 里引用变量**一律不给兜底值**。有兜底值时不报错、不白屏，只是**两套主题下
全都在用写死的浅色**（主按钮那个 `#4f7cff` 压白字只有 3.70:1）——
**静默降级比直接坏掉难查得多。** 不给兜底值，写错名字会当场看得见。

> 对照表：`--accent`→`--primary`、`--accent-soft`→`--primary-soft`、
> `--card`→`--panel`、`--chip`→`--panel-3`、`--line`→`--border`、
> `--hover`→`--panel-3`、`--border-2`→`--input`。
> **CSS 里的兜底值不一样**：`var(--cols, 1)` / `var(--week-head-h, 79px)` 是真默认值
> （那两个变量由 JS 内联设置），保留。

**`--border` 与 `--input` 按「用户能不能操作它」分档，不按「长得像不像框」**：
前者是装饰分隔线（**不要求 3:1**），后者是交互控件描边（**≥3:1**，WCAG 1.4.11）。
**焦点环统一在 `legacy.css` 文件最末那一条 `:focus-visible`**，不要再散着写 ——
它必须和 `--input` 一起改（`--input` 提到 3:1 之后，只染色的焦点环对比会掉到 1.45）。

**风格轴的两半（线粗细 / 圆角）都在 `legacy.css` 的令牌块里。**
**线的粗细**走 `--border-w`
（soft / notion 1px、flat 2px），凡是全边的 `border: … solid …` 都引用它；
**圆角**走 `--r-xs/sm/md/lg/xl/pill`，`.tsx` 里**不许出现 Tailwind 自带的
`rounded` / `rounded-lg` / `rounded-2xl`** —— 那些是写死的像素值，切到 flat / notion
时原地不动，症状就是「无论怎么切都是圆角胶囊」。按角色挑档：卡片 `--r-lg` ·
浮层 `--r-xl` · 行与按钮 `--r-md` · 输入框与下拉 `--r-sm` · 小徽标 `--r-xs`。
`color-scan.mjs` 锁着这两条，细节见 [docs/界面约定.md](docs/界面约定.md)。

`app/tests/contrast.mjs` 四段都在锁：① 74 对「文字 on 真会落上去的底色」≥ 4.5:1；
② 8 对**控件描边 ≥ 3:1**（和 4.5 那条是两条不同的线）；③ `src/` 里引用了但
`legacy.css` 没定义的变量；④ `.tsx` 里多余的 `var()` 兜底值。

**图标一律 lucide，零 emoji。弹层一律应用内，零原生 `confirm` / `alert`。**
**金额相关一律不适用**（本项目没有金额字段）。

**「哪些页面跨集、哪些按集」是定死的**（用户 2026-10-06 裁决）：

| 跨集（看全部） | 按集（只看当前选中的） |
|---|---|
| 今天 · 逾期 · 待办箱 · 垃圾箱 | 日程 · 打卡 · 已完成 |

> 表达方式是 `App.tsx` 里给这几个视图传**哪一份 state**：`state`（全量）还是
> `scoped`（`useScopedState()` 过滤过）。**不要**给 views/ 里的每个选择器加
> `calId` 参数 —— 在状态这一层分叉一次，下游十几个选择器一个都不用动。
> **侧栏徽标与顶栏一律用全量口径**，别跟着当前集变。

**只读成员看到的界面不是「藏起来」，是「点了会告诉你为什么」。**
`store.commitMany()` 挡下写入时 `denied` 计数 +1，`App.tsx` 弹一次提示。
**别让写操作静默失败** —— 用户会以为程序卡了。

> **记录只有 `store.ts` 的 `deny()` 一个入口**，别在调用点自己动 `state.denied`。
> **提示要点名是哪个集**（`deniedCals`）—— 今天 / 逾期 / 待办箱是跨集的，
> 一句「这个日程集你只有查看权限」会让人以为是眼前这个集出了问题。
> 一次操作只弹一条，不是逐条弹。
>
> 另有一条**服务器侧**的兜底：客户端角色还是旧的时，op 会被服务端拒掉
> （`engine.ts` 的 `handleRejected`，`code: 'forbidden'`），那条走顶栏 `lastError`。

**断网时界面也必须说话。** 顶栏 `.sync-dot` 的位置**离线优先**：断网时显示一个
☁︎ 划掉（`CloudOff`）配 title「离线，改动先存在本机，联网后自动同步」，
而不是那个会一直转下去的加载圈 —— 一直转看起来就是卡死了。
来源是 `ui/hooks.ts` 的 `useOnline()`，**不是**「上一次请求成不成功」。

**没有登录？有登录。** 但**没有密码找回、没有邮箱、没有第三方登录**。
**也没有管理员** —— 平等多用户、开放注册，注册完自动有一个「我的日程」。
> **别在界面上提「管理员」**，也**别写「第一个人是管理员」** —— `users.is_admin`
> 这一列已经没有了。

### 无障碍：三条不变量 + 一个已踩过的坑（2026-10-06）

**1. 每个控件都要有可访问名字。** 四种写法，按场合挑：

| 场合 | 怎么写 | 例子 |
|---|---|---|
| 有可见标签的输入框 | `useId()` + `<label htmlFor>` | `Drawer.tsx` 的日期 / 时间 / 时长 / 重复 / 备注 |
| 下拉框、没有可见标签的框 | `aria-label` | 管理浮层那两个角色 `<select>`、邀请用户名框 |
| 只有图标的按钮 | `<IconBtn label="…">`（`ui/kit.tsx`） | 抽屉的关闭、各类「删除 / 移出」 |
| 有文字的按钮 | 什么都不用加 | 可见文字**就是**它的名字 |

> **`placeholder` 不算名字** —— 它输入后就没了。这一条踩过：探针本来接受
> placeholder，于是管理浮层那个「名字」框**整整一轮没被任何断言看过**。
> 现在 `browser-smoke.mjs` 的 `nameOf()` 明确不接受 placeholder，别再加回去。

**2. 勾选圈一律走 `views/parts.tsx` 的 `<CheckBtn>`。** 六个调用点原先各写一遍，
于是各自长歪。**别再手写 `span.check-btn`。**

**3. 命中区 ≥ 24×24（WCAG 2.5.8），但视觉尺寸不变。**
`.check-btn` 本体 18px、`.sm` 只有 14px，靠 `::before` 往外撑到 24 ——
**不是把圆点画大**，画大就毁了列表密度。

> 实测有个取整细节别当成 bug：整数步进的探针在 24 的边界上会读到 **23**。
> CSS 声明的尺寸是达标的，别为了这一格去改 CSS。

### 键盘：一档微调，不做全套（2026-10-06 用户裁决）

> 「不需要过分考虑键盘操作，只要最简单的方向键能微调即可，其他的地方也是。」

**时间轴两个把手（`.ev-resize` / `.ev-resize-top`）是页面上仅有的两个
不可点、只能拖的控件** —— 其余每一个 `data-act` 都是真 `<button>`，Tab 就能到。
所以键盘支持只需要补这一处：两个 `<span>` 给上 `tabIndex={0}` + `aria-label`
（`views/Calendar.tsx`），方向键那一段在 `App.tsx` 的键盘委托里，
算法走 `domain/date.ts` 的 `nudgeEdge()` —— **和鼠标拖拽共用同一份算式**。

- 键位只有 ↑ / ↓。**方向跟着时间轴走**（往下 = `+1`），不是「变长 / 变短」。
- 一次一档 **15 分钟**，和拖拽的步进一致。
- 焦点在把手上时**只有方向键**被截走，`1/2/3` 切视图、`d/t` 跳页那些不受影响。
- **别再加别的键位** —— 用户明确说了不要。

### 浮层的语义与焦点（2026-10-06）

**凡是真的盖住整页的浮层，必须同时做四件事**，少一件就有一句是假话：

| 做什么 | 在哪 | 少了会怎样 |
|---|---|---|
| `role="dialog"` + `aria-modal="true"` + 名字 | `Drawer.tsx`、`kit.tsx` 的 `Sheet`、`Shell.tsx` 的 `MoreSheet` | 读屏只念到一堆孤立的输入框 |
| **`useFocusTrap(panel, open)`** | `ui/hooks.ts`，三个浮层都挂 | `aria-modal` 承诺「外面别念」，Tab 却能走到背后 |
| 开时把焦点送进**面板本身**（`tabIndex={-1}` + `panel.focus()`） | 同上 | 送进第一个输入框会**当场弹出手机软键盘**（用户明确要求过：别抢焦点弹键盘） |
| 关时 `prevFocus.focus()` 还回原处 | 同上 | 焦点掉到 `body` 上，键盘用户得从页首重新 Tab 一遍 |

> **记录「原来那个元素」之前先看焦点在不在浮层里**（`panel.current?.contains(document.activeElement)`）。
> 从一条任务切到另一条时 `id` 变了但组件不卸载，这时 `activeElement` 就是浮层自己，
> 记下来等于把「还回哪」擦掉。
>
> 遮罩加 `aria-hidden="true"`：它只是个鼠标目标（键盘走 Escape）。
> `.drawer:focus-visible` / `[role="dialog"]:focus-visible` 在 `legacy.css` 末尾
> **关掉焦点环** —— 必须写在 `legacy.css` 里：Tailwind 的 `outline-none` 在 `@layer`
> 里，压不过它（见[踩坑 17](docs/踩坑.md)）。

### 状态语义：`aria-current` / `aria-expanded` / `aria-haspopup`（2026-10-06）

这三个各有各的场合，**别混着用**（`aria-expanded` 摆在只是弹浮层的按钮上，
读屏会念成「已折叠」—— 那里根本没折叠这回事）：

| 属性 | 用在哪 | 判据 |
|---|---|---|
| `aria-current="page"` | 侧栏 `.nav-item`、底部标签栏 `.tab` | 「现在在哪一页」 |
| `aria-expanded`（+ `aria-controls`） | 「今天已完成」的 `.td-head`、「找日期」的 `.jump-btn` | **真的是个折叠开关** |
| `aria-haspopup="dialog"` | 管理当前日程集 / 邀请收件箱 / 找日期 | 按下去会弹一个浮层，但开没开是 App 那一层的状态 |

> 后两个的差别就是「开没开这个状态**在谁手里**」。

### 降低动态效果：全站关，只有「正在同步」例外（2026-10-06）

`legacy.css` **文件最末**一段 `@media (prefers-reduced-motion: reduce)`：
通配 `*` + `!important` 把 `animation-duration` / `transition-duration` 压到
`.01ms`、`scroll-behavior` 复位。

- **为什么不挑几个「大动作」**：会动的地方有十几处，挑漏一处就等于没关，
  而且日后再加一处也不会有人记得回来补。
- **唯一的例外是 `.animate-spin`**（同步中的加载圈）：它不是动效，是在说
  「正在同步，别以为卡死了」。停下来传达的正好是相反的意思。
- 这一条必须**压得过内联 style 和 Tailwind 层**，所以 `!important` 不是偷懒。

### 说明性文字：默认不写，写就写一句（2026-10-07）

控件的名字已经说了它是什么——label、按钮文字、图标的 title / aria-label。
下面这些**不重复**：

| 该写 | 不该写 |
|---|---|
| 危险操作的后果（「删了找不回来」） | 「请记得」「别忘了」「千万」 |
| 反直觉的行为（「导入是合并，不覆盖」） | 用户看得见的东西（「表盘上画着 12」） |
| 不可逆的事（「忘记密码无法找回」） | 枚举不存在的功能（「没有邮箱、没有手机、没有管理员」） |

**三条硬规则：**

1. **默认不写。** 非必要不加说明——控件自明就不用解释。
2. **写就写一句。** 一句话说清，不写段落；一句装不下就说明这个控件本身没设计好。
3. **不把人当傻子。** 不替用户下结论，不解释显而易见的事，不枚举没有的东西。

> 先例：`ui/Clock.tsx` 表盘下那行「选小时（12 在顶部）」已删——表盘自己就画着 12，
> 写出来只是把人当不会看（理由在该文件头第 5 条）。这条规范是把那个决定从
> 「一个控件」推广到**全站文案**。

**placeholder 只给格式示例**（如「10月15日」「学英语」），**不当可访问名字**——
可访问名字靠 label / aria-label / 可见文字，见上面「无障碍」。

---

## 四、最容易翻车的十条

> 完整 40 条见 [docs/踩坑.md](docs/踩坑.md)。这十条是**最常踩、且症状最会骗人**的。

**1. 两个 Service Worker 会打架**（[踩坑 1](docs/踩坑.md)）
新版自己也注册了 SW，所以「注销作用域内所有 SW」那一招会把自己刚注册的也干掉。
拆旧 SW 那段用 localStorage 标记锁成**一次性**；删缓存时只认 `/^schedule-v\d+$/`，
**新版那个 `sched-shell-*` 不能删**。

**2. LWW 逐字段，幂等不靠 oplog，时间戳只拒绝不钳制**（[踩坑 3](docs/踩坑.md)）
比较键 `(ts, deviceId)` 在创建 op 时固定，重放时完全相同 → 一行都不改。
**不要**再加一张「这批 op 处理过了」的表。时间戳超过 24 小时就退回标 `code: 'clock'`，
**不要钳制** —— 钳制值取决于「收到请求的那一刻」，重放两次会钳出两个值，幂等性当场破掉。

**3. 拖动排序用「让位洞」模型，不是插入线**（[踩坑 6](docs/踩坑.md)）
位置一律按 dragstart 时量的 `rawLayout`，**不能用实时坐标**（让位是加在元素上的
`transform`，`getBoundingClientRect()` 读到的是位移后的值）。
**不要再退回插入线模型。**

**4. 触屏与鼠标两条路完全分开，只共用落点**（[踩坑 12](docs/踩坑.md)）
输入那一段在 `ui/dnd.ts` 的文件头；落点那一段（`applyDropAt` / `finishDrag` /
`commitDrop`）**是同一份代码**。改落点逻辑时两条路一起变，这是故意的。
抬手那一下必须把浏览器补的鼠标事件整串掐掉，否则「长按完什么也没发生」。

**5. CSS 层叠两条**（[踩坑 17](docs/踩坑.md)）
同特异度后写的赢 —— 给折叠元素加类时要查 `display`。
Tailwind 4 把它的东西全塞进 `@layer`，**没有层的作者样式永远赢过任何层内的样式** ——
所以 `legacy.css` 压在所有工具类之上；代价是**在 legacy 已覆盖的元素上工具类不生效**。

**6. 工程目录在 SMB 上，偶发丢文件**（[踩坑 21](docs/踩坑.md)）
传大文件先写本机磁盘再 `cp` 过去，然后 `md5sum` 两端核对；**改完就提交**。
**别用 `perl -i` / `sed -i`** —— 它们在 CIFS 上靠「写临时文件再改名」，
改名会失败、**原始文件会当场消失**。

**7. 解析器的规则顺序不能重排**（[踩坑 25](docs/踩坑.md)）
**「重复」整组必须在「日期」整组之前**，否则「每周一」会被日期规则当成「周一」
解析成某个具体日期。`大后天` 必须排在 `后天` 前面，`下下周一` 必须排在 `下周一` 前面。
「找日期」输入框是另一套解析器，**裸周几的口径必须和 `parse()` 一致**。

**8. 探针表达式：`waitFor` 只吃表达式、`evalJs` 要自己 `return`**（[踩坑 29](docs/测试.md)）
`waitFor` 的表达式**不能以换行开头**（ASI 会把 `return` 断成空语句，求值恒为
`undefined`，一直等到超时）；`evalJs` 不会替你补 `return`，光写一个表达式等于算完就丢。
**规矩：`evalJs` 一律写 `return …;`，`waitFor` 一律不写。**

**9. 行尾一律 LF，`.gitattributes` 锁着**（[踩坑 36](docs/踩坑.md)）
`* text=auto eol=lf`。**`eol=lf` 不能省** —— 只写 `text=auto` 的话，
`core.autocrlf=true` 的机器检出时又会写出 CRLF。
判断一份 diff 是不是纯行尾改动，用 `git diff --ignore-all-space`。

**10. 跑完测试必须收干净，否则下一轮假失败**（[踩坑 40](docs/测试.md)）
`pkill -x chrome` 确认进程归零；`ss -ltnp | grep -E '5198|25701'` 找出残留服务
`kill` 掉。**要连着跑多个测试之前先确认 5198 / 25701 / 25692 都没人占** ——
这两个端口是写死的，撞了没有自动避让。

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
