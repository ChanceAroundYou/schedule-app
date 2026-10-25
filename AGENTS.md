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
│   ├── src/App.tsx    97 行，**只有启动 / 登录分流**，不碰业务状态
│   ├── src/app/       工作台：Workbench.tsx + 14 个按职责拆开的兄弟模块
│   ├── src/domain/    纯逻辑，**零 React / DOM / 网络**
│   ├── src/data/      localStorage + 接口封装 + 旧数据导入
│   ├── src/sync/      同步引擎：outbox 推送 + 游标拉取
│   ├── src/ui/        侧栏 / 顶栏 / 抽屉 / 拖拽 / 日程集 / 设置 / AI 面板
│   ├── src/views/     纯展示，**零回调**，只出 data-* 属性（含项目泳道看板）
│   ├── src/styles/    语义样式模块 + tailwind.css
│   └── public/ · tests/
├── server/       后端（Node 22，**只引 AI 那一组依赖**）
│   ├── server.js      路由表 + 处理器 + 鉴权中间件
│   ├── lib/           db · auth · sync · calendars · invites · ratelimit
│   └── lib/ai/        **AI 唯一能碰 pi 的地方**
├── deploy/       发布脚本 + nginx conf / systemd 单元
└── dist/         构建产物（勿手改）· legacy/（旧版，冻结）· docs/
```

**线上只有 `~/.local/schedule/web` 被 nginx 伺服**，源码 / `server/` / `legacy/` /
文档一律 404。工程里的 `dist/` 只是本地产物，**不等于上线**（见 [DEPLOY.md](DEPLOY.md)）。

### 三层状态，别混

| 层 | 在哪 | 谁是真相 |
|---|---|---|
| 领域模型 | `state.tasks` / `state.habits`（**按 id 索引的对象**，不是数组） | ← |
| 本地存储 | localStorage `schedule-app-v4` | 离线副本 |
| 服务端 | SQLite `~/.local/schedule/data/schedule.db` | **权威** |

排查「数据不对」**先看服务器**。

### 怎么跑起来

```bash
node server/server.js            # 后端 :25692，数据落 server/data/
SCHEDULE_DATA_DIR=/tmp/x node server/server.js   # 换数据目录（跑测试时用）
cd app && npm run dev            # Vite :5199，/api 代理到 127.0.0.1:25692
cd app && npm run build          # tsc -b && vite build → ../dist/
```

> `dev` / `preview` 都占 5199，别同时开。`preview.proxy` 是 `vite.config.ts` 里**另一段**
> —— 只写 `server.proxy` 的话预览里所有 `/api` 都 404。

**依赖装在本机磁盘，不在工程目录**（工程目录经 SMB 共享给 Windows，见
[踩坑 21](docs/踩坑-环境.md)）。**用软链，不用 `NODE_PATH`**；`node_modules` 不进仓库，
每份 checkout 自己补：

```bash
./deploy/install-deps.sh                                          # 后端：装到 ~/.local/schedule/deps
ln -s ~/.local/schedule/deps/node_modules ./node_modules          # 后端
ln -s <主仓库>/app/node_modules app/node_modules                  # 前端，复用主仓库那份
```

缺后端那条服务照样起得来（`lib/ai/index.js` 惰性 import），只是 AI 页报「依赖没装好」。

### `App.tsx` / `Workbench.tsx` 各管什么

`src/App.tsx`（97 行）**只有启动与登录分流**：`store.load()` → `engine.bootstrap()` /
`start()` → 没 token 渲染登录页、有 token 渲染 `<Workbench>`。**auth 门禁在这里** ——
没登录连 store 都不落地（否则没账户的浏览器会先写一份本机数据，登录后再往里倒）。

`src/app/Workbench.tsx`（326 行）是**唯一知道「全部状态」的地方**，但**只负责组装**：

1. **两份 state**：`state`（全量，跨集页面看）/ `scoped`（只含选中集，日程 / 打卡 /
   已完成 / 项目看）—— 这一处决定了「哪些页面跨集」。
2. **浮层开关**与各处回调接线。那棵 JSX **故意不再拆**：每个 prop 都直接给到真正
   需要它的组件，再包一层只是把同一份清单抄两遍。
3. **拖拽 / 拉伸 / 长按提起**（`DndProvider` + `.ev-resize`）。

判断本身按职责放在同目录的兄弟模块里：

| 模块 | 管什么 |
|---|---|
| `clickDispatch.ts` | `#content` 上**那一个** `onClick`，靠 `data-*` 分派 |
| `useNav.ts` · `useTaskActions.ts` · `useContentEvents.ts` | 换页 / 新建删除上下移 / `#content` 原生监听 |
| `contentDispatch.tsx` | 按 `nav` 选视图（`settings` 在「没有集」那道门禁之前） |
| `resizeTimeline.ts` · `keyboard.ts` · `kb.ts` | 时间轴把手 · 快捷键 · 软键盘变量 |
| `backup.tsx` · `pickDate.ts` · `useDeniedToast.ts` | 导出导入 · 行内改期 · 写权限被挡的提示 |
| `tapSnap.ts` · `touchDamp.ts` · `domWindow.ts` · `navLabel.ts` | 就地新建落点 · 橡皮筋 · 窗口测量 · 导航标签 |

**为什么点击必须在容器上委托**：行是 React 渲染的，拖拽重排 / 同步落地会换掉它们，
挂在行上的 handler 跟着丢；容器级 handler 永远在。**代价**：`views/` 全纯展示、
**零回调**，只出 `data-*`。分派顺序 `[data-act]` → `[data-jump]`/`[data-nav]` →
`.task-el` → `[data-zone-id]`，**第四步必须在第三步之后**（`.month-cell` 带 `data-no-draft`）。

### 导航

`NAV_ALL`（`domain/model/ui.ts`）= `inbox · today · overdue · calendar · projects ·
habits · done · ai · trash · settings`。`CUSTOMIZABLE` 去掉 `settings`；底栏
`TAB_MAX = 4`，「更多」恒占最后一格。`ui.tabs ← ui.navOrder` 的换算只有
`orderTabs()` 一个出口（`store.setUi()` 是裸浅合并，派生字段会静默过期，[踩坑 49](docs/踩坑-前端-组件.md)）。

---

## 二、不变量（**最要紧**）

> 推导、字段表、失败症状 → [docs/业务模型.md](docs/业务模型.md)。这里只留「不许破」。

### 数据结构六条

1. `tasks` / `habits` 是**按 id 索引的对象**，不是数组。
2. `calId` 是**主键的一部分**，不是可同步字段（同 `_ts` / `_dev`）→ **挪集 = 目标集
   新建一条 + 源集留墓碑**。
3. **删除是墓碑**：`deleted` 让别的设备知道要删，`purged` 才到处看不见。
4. **三态各自独立**：未定时（`time===null`）· 未定日期（`date===null`）· 已完成仍占
   日程位置。**只有第二态进待办箱。**
5. **待办箱 = `date === null` 的未完成任务**；未定时是另一回事。
6. **任务与打卡独立**，`habits.log` 是按日期的稀疏映射。

**不做长篇幅记录** —— 备忘录 / 清单 / 笔记本已整体删除，迁移是**丢掉不是归档**。
**别再加回来。**

### 权限

**没有管理员，所有人平等，开放注册。共享的单位是集，不是任务**（像相册）。

| 角色 | 改任务 / 打卡 | 改集与成员 |
|---|---|---|
| `owner` | ✅ | ✅ |
| `editor` | ✅ | ❌ |
| `viewer` | ❌ | ❌ |

**判断只有两个入口**：`canWrite(role)` / `canManage(role)`（`domain/types.ts`）；服务端走
`db.roleOf()` / `calendars.canWrite()`。**别在别处写 `role === 'owner'`。**

**三条不变量**：① 每人永远至少一个集（`ensureHasCalendar`）；② 每集永远至少一个 owner；
③ **写权限在写入通道把关**（`store.commitMany()` 与 `sync.applyOps()` 各挡一次），
不是靠界面藏按钮。**邀请两段式**，对方接受后才生效。

### 同步

`changes.seq` **全局单调**，客户端只存**一个** `cursor`，服务端按 `cal_id IN (我的集)` 过滤。

> **新加入一个集时，它的历史变更全在游标后面** —— 客户端一看到不认识的 `calId`，
> 就**再要一次全量快照**（`engine.ts` 的 `syncNow()` 里 `known` 判断）。

`POST /api/sync` **一次调用同时推和拉**，服务端**先落盘再取数**。**集 / 成员 / 邀请走普通
REST，不走 LWW**（是「关系」不是「字段」）。**LWW 逐字段**（[踩坑 3](docs/踩坑.md)）；
同字段两边都改过时抽屉里多一条只读提示，**提示不改数据**。

### AI：它是「另一台设备」

**读走 `sync.snapshot(userId)`，写走 `sync.applyOps(userId, ops)`，`deviceId` 固定
`'ai'`。** `snapshot()` 已按 `calendarIdsFor()` 过滤、已剔墓碑；`applyOps()` 里有
`canWrite(...)`，是全项目唯一的服务端把关点，**绕过去 = 只读成员能被 AI 写穿**。

**写路径三段：工具 → 提案 → 确认。**

1. **写工具的 `execute` 正常返回但只造提案、不落库**（`Map<toolCallId, proposal>`）——
   强制是**结构性**的：写工具没有写的能力。**不用 pi 的 `beforeToolCall` 拦**（`block`
   会产生错误工具结果，模型以为工具坏了反复重试）。
2. 提案按 **`toolCallId`** 关联消息（**不按执行顺序**：pi 默认并行跑同一轮工具）。
3. `POST /api/ai/confirm` 是**唯一真正落库的地方**，**只信 id 不信参数**：按 id 读回提案、
   **重查权限**，再走 `applyOps`。信客户端回传的 args 等于把权限判断交给浏览器。

**提案里存的是 `fields`（最终落进 op 的字段），不是「意图」。**

### 重复规则 / 逾期

- **防死循环的判据是「必须往前走」**：`while (next && next < today && next > cursor)`。
  曾经的 `guard < 800` 是错的（2020 年起的「每天」要 2400+ 步）。**别换回魔法数字。**
- **实例 id 是派生的**：`` `${根}#${发生日}` `` —— 两台设备离线推进会派生同一个 id，
  同步时合并成一条。**这是同步模型里最要紧的一条不变量。**
- **逾期唯一口径**：`!done && date && date < today`。`counts().today` **不含逾期**。

---

## 三、界面硬规则（**跨切面**）

> 像素与推导 → [docs/界面约定.md](docs/界面约定.md) 及三册分册。这里只留「不许破」。

### 交互与视觉语言

**交互统一「列表 → 详情 → 编辑」三段式**；删除走应用内确认弹层（`useConfirm`）。

- 界面不出现「备忘录」「笔记本」「清单」；文案统一「打卡」不是「习惯」（`habits` 名保留）。
- **任务是「标题 + 详细内容」**：界面叫**「详细内容」**，字段名仍是 `note`（改名等于数据迁移）。
  改名四处：抽屉标签、列表行标记、AI 提案字段名、冲突提示。
- **点日历空格子 = 就地新建**：落点由**点的位置**决定，回车落成、Esc 取消。**抽屉不是新建
  入口**，是「补细节」的地方。承载者是 `ui.draft`（瞬时状态，每次载入清空）。
- **深浅色两档**（`ui.theme`）、**风格三档**（`ui.style` → `data-style` + tokens）。**色板没有。**
- **图标一律 lucide，零 emoji；弹层一律应用内，零原生 `confirm` / `alert`。**

**令牌五条**（1–3 由 `contrast.mjs` / `color-scan.mjs` 锁，4–5 由 `card-geometry.mjs` /
`browser-smoke.mjs` 锁）：

1. **`.tsx` 引用变量一律不给兜底值** —— 有兜底值时两套主题都在用写死的浅色，
   **静默降级比坏掉难查得多**。
2. **`--border`（装饰线）与 `--input`（交互描边 ≥3:1，WCAG 1.4.11）按「能不能操作」分档**；
   焦点环在 `styles/responsive.css` 最末 `:focus-visible`，**必须和 `--input` 一起改**。
3. **风格轴两半**：线粗细 `--border-w`，圆角 `--r-xs/sm/md/lg/xl/pill`；**`.tsx` 不许出现
   Tailwind 自带 `rounded` / `rounded-lg` / `rounded-2xl`**（写死像素，切档原地不动）。
4. **卡片圆角跟卡自己的短边走，全项目只此一条算式**：
   `min(var(--r-xl), max(2px, calc(var(--card-h) * var(--card-r-k))))`，每种卡把高度报进
   `--card-h`（定时 `--card-px`、未定时 `--row`、月胶囊 `--pill-h`）。**同一属性只声明一处**
   —— 后写的同特异度老皮肤会静默吃掉（[踩坑 50](docs/踩坑-前端-组件.md)）。
   **用 `min()` / `max()` 不用 `clamp()`**（flat 档 `--r-*` 全 0，`clamp(2px,x,0)` 返回下限）。
   横向留白只有 `--card-pad-x`，**容器横向 padding 一律 0**。
5. **勾选圈视觉直径 = 所在行字号 × `--check-k`，夹 `--check-min`~`--check-max`**
   （现 k=1、夹 9~18px；列表行报 `--check-fs: var(--fs-row)`）。**别在 `.tsx` 或响应式里
   再写一档尺寸**（[踩坑 52](docs/踩坑-前端-组件.md)）。压缩阶梯压标题时**必须同时报
   `--check-fs`**，否则圈比任务名大。

**时间行只由时长决定**：`> 60 分钟` 一定有，`≤ 60`（含整 1 小时、含没设时长）没有；
**月视图永远没有**（时间挂 `title` 气泡）。判据只在 `TaskCard` 一处，别处不许再写
`display: none`。

**上下把手也按时长走**：`≥ 60 分钟` **一定有**两个把手；`< 60 分钟` 的才受 26px 像素门槛管。
别改回纯像素判据（同一张 60 分钟卡桌面 27px、窄屏 20px）。

**卡缝四边都是 1px**（`CARD_SEAM`）：上 / 下 / 右由 `TaskCard.tsx` 内联 `calc(… − CARD_SEAM)`
扣，未定时卡右边在 `calendar.css` 的 `.task-el--untimed` 扣（**两处必须同值**），间距是
容器的 `--un-gap: 1px`。**单列也要扣。**

**装不下只许压，不许加长**。`useCardFit` 按**两个轴**分别压：

| 轴 | 判据（量出来） | 阶梯 |
|---|---|---|
| 纵向 | `.ev-text` 的 scrollHeight > `.ev-body` 的 clientHeight | 行距 → 卡内留白归零 → 标题字号（下限 9px） |
| 横向 | `.ev-time` 的 scrollWidth > clientWidth | 紧凑写法先省 → 字距收紧 → **时间行自己的**字号（下限 7.5px） |

**横向那一轴不许动标题字号**。两轴落在第几档写在卡上 `data-fit`（形如 `v1h2`），探针按它
读数。卡片文案走**紧凑写法**（`timeRangeCompact` → `09:30–10:30`），抽屉 / 列表 / `title`
仍是完整写法。左对齐靠结构：标题 / 时间 / 详细内容同在 `.ev-text`，圈在 `.ev-body`。

**「哪些页面跨集、哪些按集」定死**：今天 / 逾期 / 待办箱 / 垃圾箱 / **AI** 看**全部**；
日程 / 打卡 / 已完成 / **项目**只看顶栏勾选的集（`ui.cals`）。表达方式是 `Workbench.tsx`
给视图传**哪份 state**（`state` 全量 / `scoped`），**不要**给 `views/` 选择器加 `calId`
参数。**侧栏徽标与顶栏一律全量口径。**

> **勾选（`ui.cals`）和归属（`ui.cal`）是两件事**：前者「同时看哪几个」，后者「新建落哪儿」
> （必须一个）。`store.toggleCal()` 保证归属的集一定勾着，**至少永远有一个集勾着**。

**只读成员不是「藏起来」，是「点了会告诉你为什么」**（`commitMany()` 挡下时 `denied` +1，
弹一次提示，**别让写操作静默失败**）。记录只有 `store.ts` 的 `deny()` 一个入口；**提示要点名
是哪个集**（`deniedCals`）。

### 文案：默认不写，写就一句

| 该写 | 不该写 |
|---|---|
| 危险操作的后果（「删了找不回来」） | 「请记得」「别忘了」「千万」 |
| 反直觉的行为（「导入是合并，不覆盖」） | 用户看得见的东西 |
| 不可逆的事 | 枚举不存在的功能 |

1. **默认不写。** 2. **写就写一句。** 3. **不把人当傻子。**

### 状态表达

**断网时界面必须说话**：顶栏 `.sync-dot` 显示 ☁︎ 划掉（`CloudOff`）配 title「离线，改动先
存在本机，联网后自动同步」，**不是**一直转的加载圈。来源是 `ui/hooks.ts` 的 `useOnline()`，
**不是**「上一次请求成不成功」。

**有登录，但没有密码找回、邮箱、第三方登录，也没有管理员**。注册完自动有一个「我的日程」。
**别在界面上提「管理员」**（`users.is_admin` 列已删除）。

### 无障碍

1. **每个控件都要有可访问名字**：有可见标签 → `useId()` + `<label htmlFor>`；无标签按钮组
   → `aria-label`；纯图标按钮 → `<IconBtn label="…">`；**有文字的按钮什么都不用加**。
   > **`placeholder` 不算名字**（输入后就没了）。探针取可访问名字的函数也**不许接受
   > placeholder**；`placeholder` 只给格式示例。
2. **勾选圈一律走 `views/parts.tsx` 的 `<CheckBtn>`**。**别再手写 `span.check-btn`。**
3. **命中区 ≥ 24×24（WCAG 2.5.8），视觉直径跟字号走**，靠 `::before` 撑命中区 —— **不是把
   圆点画大**。（探针在边界读到 23 是取整，别为一格改 CSS。）圈必须是**所在文字的竖直中心**：
   `.ev-body` 的 `align-items: center` 保证。
4. **盖住整页的浮层四件事**：`role="dialog"` + `aria-modal` + 名字 · `useFocusTrap(panel, open)`
   · 开时焦点送进**面板本身**（送进输入框会当场弹软键盘）· 关时 `prevFocus.focus()` 还回。
   > 记「原来那个元素」前先看焦点在不在浮层里（切任务时组件不卸载，`activeElement` 就是
   > 浮层自己）。遮罩加 `aria-hidden="true"`。浮层焦点环关在 `responsive.css` 末尾 ——
   > 必须写那儿：Tailwind 的 `outline-none` 在 `@layer` 里压不过（[踩坑 17](docs/踩坑-前端-交互.md)）。

**状态语义别混**：`aria-current="page"` = 现在在哪页；`aria-expanded` = 真的是折叠开关；
`aria-haspopup="dialog"` = 按下弹浮层，开没开在 App 那层。

**键盘只做一档微调**：两个时间把手给 `tabIndex={0}` + `aria-label`，方向键走 `nudgeEdge()`
（和鼠标共用算式），↑/↓ 一次一档 15 分钟。**别再加别的键位。**

**`prefers-reduced-motion` 全站关**（`responsive.css` 最末，通配 `*` + `!important`），
**无例外**（同步圈也停）。会动的地方十几处，挑漏一处等于没关。

---

## 四、最容易翻车的九条

> 完整 54 条见 [docs/踩坑.md](docs/踩坑.md) 的索引（每条在三份分册里）。

| 坑 | 一句话 |
|---|---|
| SW 打架 | 「注销作用域内所有 SW」会干掉自己刚注册的；拆旧 SW 用 localStorage 标记锁成一次性，删缓存只认 `/^schedule-v\d+$/`（[踩坑 1](docs/踩坑.md)） |
| 拖拽排序 | 用「让位洞」不用插入线；位置一律取 dragstart 量的 `rawLayout`，**不用实时坐标**（[踩坑 6](docs/踩坑-前端-交互.md)） |
| 拖拽传感器 | 鼠标 `distance: 8`、触摸 `delay: 300 + tolerance: 8`（`ui/dnd/sensors.ts`）；AutoScroll 已在两处关掉。**拖出容器用分身**（`ui/dnd/lift.ts`），**别切 `overflow: visible`**（浏览器会抹掉 `scrollTop`），也别让 `touchDamp` 在 `isDragging()` 时写 `--pull`（[踩坑 51](docs/踩坑-前端-组件.md) · [54](docs/踩坑-前端-组件.md)） |
| 探针表达式 | `waitFor` 只吃表达式、`evalJs` 要自己 `return …;`（[踩坑 29](docs/踩坑-环境.md)） |
| 行尾 | 一律 LF，`.gitattributes` 的 `* text=auto eol=lf` —— **`eol=lf` 不能省**（[踩坑 36](docs/踩坑-环境.md)） |
| 收尾 | 跑完 `pkill -x chrome` 归零、`ss -ltnp` 找出残留服务 `kill`。端口避让只管这一趟，撞着的那趟会静默连到残留旧后端（[踩坑 40](docs/踩坑-环境.md)） |
| 共享盘 | 工程目录经 SMB 共享，偶发丢文件：大文件先写本机再 `cp` + `md5sum`；**别用 `perl -i` / `sed -i`**（[踩坑 21](docs/踩坑-环境.md)） |
| 不猜日期 | 快速添加不解析文本，日期 / 时间只有「面板选的 > tab 默认值」两个来源（[踩坑 25](docs/踩坑-环境.md)） |
| CSS 层叠 | 同特异度后写赢（给折叠元素加类要查 `display`）；Tailwind 4 全在 `@layer` 里，**没有层的作者样式永远赢**（[踩坑 17](docs/踩坑-前端-交互.md)） |

---

## 五、给 AI 的硬约束

1. **后端只许引 AI 那一组依赖**，其余全用 Node 标准库。**pi 的 import 只许出现在
   `server/lib/ai/` 目录里**（现 8 个文件，全在该目录下），依赖锁精确版本、装本机磁盘。
2. **不引入 `v1` / `v2` 版本号并存** —— 结构变了就归档旧 key + 写迁移。
3. **不改 nginx 路径结构**（没有 `/schedule2/`），回滚靠换线上目录内容。
4. **前端新依赖要先问** —— 每一个都是「现有视觉做不到才加的」。
5. **`domain/` 保持纯净**（无 React / DOM / 网络），它要能在 Capacitor 与 Node 里跑。
6. **权限判断只在 `canWrite` / `canManage` / `db.roleOf()` 三个入口。**
7. **别在文档里写密码。**
8. **写完新组件顺手跑 `contrast.mjs` + `color-scan.mjs`**（各几秒）—— 它们是令牌 1–3 的
   唯一自动守卫（4–5 走 `card-geometry.mjs` / `browser-smoke.mjs`）。端到端交互没有自动化
   覆盖，改完手工走一遍。
9. **发布走 `deploy/publish-*.sh`**，不要手动覆盖线上目录（见 [DEPLOY.md](DEPLOY.md)）。
10. **生产目录只由发布脚本写入，而且发布必须用户授权** —— 脚本默认 dry-run，只有
    `--approve` 才动 `~/.local/schedule/`。**不要替用户加 `--approve`**，也不要
    `--allow-dirty` / `--allow-unpushed` 绕过体检。用户没说「发」就只跑 dry-run。
11. **双端开发：Windows 在 `dev`，ubuntu 工程目录在 `main`，各推各的。** 合流由用户手动做
    —— 冲突时**报告差异，不要替他选一边**。尤其别动 ubuntu 那份工作区。
12. **工作区保护是铁律**：动 git 前先看 `status` / `stash list` / `ls-files -u`；有**别人的**
    改动 → 先 `git stash push -u` 或 WIP 分支存档，**绝不覆盖**。禁用 `checkout --` /
    `reset --hard` / `clean -fd` / `push -f` / `stash drop`。提交信息带「来源：」一行。
    完整规则见 [docs/工作区保护.md](docs/工作区保护.md)。
13. **就地新建的落点由 `pointerdown` 快照决定**（`app/src/app/tapSnap.ts`）。键盘弹起时界面压矮，
    `e.clientY` 是按下坐标、`getBoundingClientRect()` 是 click 时布局 —— 混用会把 21:00
    算成 7:00。**不要改回「click 时读 rect」。**
