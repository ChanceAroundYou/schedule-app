# 日程清单

个人用的任务与打卡网页。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
**前后端分离**：React 前端 + 自写 Node 后端 + SQLite，数据在服务器上。

| 文件 | 内容 |
|---|---|
| `CLAUDE.md` | **本文 —— 往哪走**：结构、不变量、界面硬规则、最容易翻车的十条 |
| [docs/业务模型.md](docs/业务模型.md) | 完整字段表、重复规则、逾期、冲突提示、**AI 三段式详情** |
| [docs/界面约定.md](docs/界面约定.md) | 配色与令牌、变量名对照表 |
| [docs/界面约定-无障碍.md](docs/界面约定-无障碍.md) | 无障碍 / 键盘 / 浮层 / 动效 |
| [docs/界面约定-布局.md](docs/界面约定-布局.md) | 顶栏、周视图、软键盘避让 |
| [docs/界面约定-快速添加.md](docs/界面约定-快速添加.md) | 快速添加：圆钮 / 两层折叠面板 / 转盘 |
| [docs/踩坑.md](docs/踩坑.md) | **改代码前先读**：49 条坑的索引（1–4 同步 / 数据） |
| [docs/踩坑-前端.md](docs/踩坑-前端.md) | 第 5–20、41–49 条：前端 / UI |
| [docs/踩坑-环境.md](docs/踩坑-环境.md) | 第 21–41 条：环境 / 工具（CIFS、Chrome、探针、端口） |
| [docs/测试.md](docs/测试.md) | 怎么验、每条约定锁在探针哪一节 |
| [docs/接口.md](docs/接口.md) | HTTP 接口总览 + 认证（另有 `-日程集` / `-同步` / `-AI` 三份） |
| [DEPLOY.md](DEPLOY.md) | 拓扑、上线（另有 `-nginx` / `-conf` / `-运维` / `-排障` 四份） |
| [docs/重构路线.md](docs/重构路线.md) | 2026-10-06 重写的决策记录（**冻结，不删旧结论**；另有
`-同步` / `-计划` / `-记录` 三份） |
| [README.md](README.md) | 给人看的：网址、怎么用、数据在哪 |

**改代码前先读 [docs/踩坑.md](docs/踩坑.md) 和「三、界面硬规则」。**
> 本文「**踩坑 N**」= 上面那三份里编号为 N 的那一条（1–4 在 `踩坑.md`，5–20 与
> 41–49 在 `踩坑-前端.md`，21–41 在 `踩坑-环境.md`）。**编号是稳定引用，别改。**

---

## 一、结构

```text
日程管理/
├── app/          前端（React + TS + Vite，有构建）
│   ├── src/domain/    纯逻辑，**零 React / DOM / 网络**
│   ├── src/data/      localStorage + 接口封装 + 旧数据导入
│   ├── src/sync/      同步引擎：outbox 推送 + 游标拉取
│   ├── src/ui/        侧栏 / 顶栏 / 抽屉 / 拖拽（`dndkit.tsx`，@dnd-kit）/ 日程集 / AI 面板
│   ├── src/views/     纯展示，**零回调**，只出 data-* 属性
│   ├── src/styles/    语义样式模块（tokens / shell / calendar / lists / quick-add / overlays / responsive）+ tailwind.css
│   └── public/ · tests/
├── server/       后端（Node 22，**只引 AI 那一组依赖**，见五、1）
│   ├── server.js      路由表 + 处理器 + 鉴权中间件
│   ├── lib/           db · auth · sync · calendars · invites · ratelimit
│   ├── lib/ai/        **AI 唯一能碰 pi 的地方**（见二、AI）
│   └── tests/         api · migration · ai · smoke-share
├── dist/         构建产物（生成物，勿手改；**nginx 只伺服这里**）
├── deploy/ · legacy/（旧版，**冻结**，回滚用）· docs/
└── README.md  CLAUDE.md  DEPLOY*.md  .gitattributes
```

**只有 `dist/` 会被 nginx 伺服**，源码 / `server/` / `legacy/` / 文档一律 404。

**三层状态别混**：领域模型（`state.tasks` / `state.habits`，**按 id 索引的对象**，不是数组）
→ localStorage `schedule-app-v4`（离线副本）→ SQLite `~/.local/schedule/data/schedule.db`
（**权威**）。排查「数据不对」**先看服务器**，浏览器那份只是副本。

它是**唯一知道「全部状态」的地方**，所以这几样必须有全局视野的东西都放这儿：

1. **渲染调度**：`useStoreState()` 订阅 `store`，`renderAll` 对应一次重渲染。
2. **点击事件委托**：`#content` 上挂**一个** `onClick`，靠 `data-act` /
   `data-nav` / `data-jump` / `data-id` 分派。
   > **不是「懒得拆」，是必须这样。** 行是 React 渲染的，拖拽重排、同步落地
   > 都会把它们换掉，挂在行上的 handler 会跟着丢。容器级 handler 永远在。
   > 代价：`views/` 里全是纯展示组件，**零回调**。
3. **拖拽 / 拉伸**：`DndProvider`（@dnd-kit）+ `.ev-resize` 的 mousedown。
4. **长按提起 + 触屏拖拽 / 长按操作层**（触屏）、**快捷键**、**导出 / 导入**。

### 三层状态，别混

| 层 | 在哪 | 谁是真相 |
|---|---|---|
| 领域模型 | `state.tasks` / `state.habits`（**按 id 索引的对象**，不是数组） | ← |
| 本地存储 | localStorage `schedule-app-v4` | 离线副本 |
| 服务端 | SQLite `~/.local/schedule/data/schedule.db` | **权威** |

> 排查「数据不对」**先看服务器**。浏览器那份只是副本。

**怎么跑起来**：

```bash
cd app && npm run dev            # Vite :5199，/api 代理到 127.0.0.1:25692
node server/server.js            # 后端 :25692，数据落 server/data/
SCHEDULE_DATA_DIR=/tmp/x node server/server.js   # 换数据目录（跑测试时用）
cd app && npm run build          # tsc -b && vite build → ../dist/
```

> **`dev` / `preview` 都占 5199，别同时开。** `preview` 用的是 `vite.config.ts` 里
> **另一段** `preview.proxy` —— 只写 `server.proxy` 的话预览里所有 `/api` 都 404。

**依赖装在本机磁盘，不在共享盘**（CIFS 上成千上万个小文件正是踩坑 21 那个丢文件风险）。
**用软链而不是 `NODE_PATH`** —— 软链不需要 systemd 那条 `Environment`，也不挑进程是从哪个
目录起的。
`node_modules` 在 `.gitignore` 里，**每份 checkout 都得自己补一次**（缺了它 AI 页报
「依赖没装好」，但服务照常起得来）：
`ln -s /home/xiaokubao/.local/schedule/deps/node_modules ./node_modules`

**`App.tsx` 为什么这么大**：它是**唯一知道「全部状态」的地方** —— 渲染调度、**点击事件
委托**（`#content` 上挂一个 `onClick`，靠 `data-act` / `data-nav` / `data-jump` 分派）、
拖拽与拉伸、触屏长按、快捷键、导入导出。委托**不是「懒得拆」，是必须这样**：行是 React
渲染的，拖拽重排与同步落地都会把它们换掉，挂在行上的 handler 会跟着丢。代价是 `views/`
里**零回调**。

**前端依赖不另装**——直接软链主仓库那份（主仓库的 `app/node_modules` 是装好的）：

```bash
ln -s /home/xiaokubao/family/星星包/coding/日程管理/app/node_modules app/node_modules
```

> 在 worktree 的 `app/` 里执行。后端那份（`schedule-deps`）装在本机磁盘，
> 前端这份直接复用主仓库的，**不重复安装**。

---

## 二、不变量（**最要紧的部分**）

> 每条规则背后的推导、字段表、失败症状 → [docs/业务模型.md](docs/业务模型.md) 与
> [docs/踩坑.md](docs/踩坑.md)。**这里只留「不许破」的那一句。**

**工具分工**：本项目不做长篇幅记录 —— 备忘录 / 清单 / 笔记本三个模块已整体删除，迁移是
**「丢掉」不是「归档」**（没有 `archive` 字段，也不写 `schedule-app-notes-archive`）。
**别再加回来。**

### 数据结构：六条不能破的

1. `tasks` / `habits` 是**按 id 索引的对象**，不是数组。
2. `calId` 是**主键的一部分**，不是可同步字段（和 `_ts` / `_dev` 一样只存在本地）→
   **挪集 = 目标集新建一条 + 源集留墓碑**，不是改一个字段。
3. **删除是墓碑**：`deleted` 让别的设备知道「要删」，`purged` 才在任何地方都看不见。
4. **三态各自独立**：未定时（`time===null`）· 未定日期（`date===null`）· 已完成但仍占
   时间段（`done && time`，灰显留在时间轴上）。**只有第二态进待办箱。**
5. **待办箱 = `date === null` 的未完成任务**；未定时是另一回事（`date` 有、`time` 为空）。
6. **任务与打卡是两个独立模块**，`habits.log` 是按日期的稀疏映射。

### 权限

**没有管理员，所有人平等，注册开放。共享的单位是集，不是任务**（像相册）—— 没有
「把这一条任务分享给某人」这回事。

| 角色 | 改任务 / 打卡 | 改集与成员 |
|---|---|---|
| `owner` 创建者 | ✅ | ✅ |
| `editor` 可编辑 | ✅ | ❌ |
| `viewer` 只读 | ❌ | ❌ |

> **判断只有两个入口**：`canWrite(role)` / `canManage(role)`（`domain/types.ts`）；服务端
> 同理，只走 `db.roleOf()` / `calendars.canWrite()`。**别在别处写 `role === 'owner'`。**

**三条不变量**：① 每个人永远至少有一个集（`ensureHasCalendar`）；② 每个集永远至少有一个
owner（最后一个不能被降级 / 移出 / 退出）；③ **写权限在写入通道那层把关**，不是靠界面藏
按钮 —— `store.commitMany()` 与 `sync.applyOps()` 各挡一次。**邀请两段式**，对方接受后才
生效（`pending → accepted | declined | revoked`）。

### 同步

`changes.seq` 是**全局单调**的自增主键，客户端只存一个 `cursor`（不是每个集一个），服务端
按 `cal_id IN (我的集)` 过滤。

> **新加入一个集时，它的历史变更全在游标后面**，光靠增量**永远拉不到** —— 所以客户端一
> 看到不认识的 `calId`，就**再要一次全量快照**（`engine.ts` 的 `syncNow()` 里那段
> `known` 判断）。

`POST /api/sync` **一次调用同时推和拉**，服务端**先落盘再取数**。**集 / 成员 / 邀请走普通
REST，不走 LWW**（它们是「关系」不是「字段」）。**LWW 是逐字段的**（[踩坑 3](docs/踩坑.md)）；
同字段两边都改过时抽屉里多一条只读提示，**提示不改数据**。

### AI：它是「另一台设备」，不是一条新通道

**读走 `sync.snapshot(userId)`，写走 `sync.applyOps(userId, ops)`，`deviceId` 固定
`'ai'`。** 三个复用各有理由：`snapshot()` 已按 `calendarIdsFor()` 过滤、已剔墓碑；
`applyOps()` 里有 `canWrite(db.roleOf(...))`，是全项目唯一的服务端把关点，**绕过去 =
只读成员能被 AI 写穿**；写进 `changes` 带新 `seq`，客户端本来就会拉到。

**写路径三段：工具 → 提案 → 确认。** ① **写工具的 `execute` 正常返回，但只造提案、不落
库**（`Map<toolCallId, proposal>`）—— 真正的强制是**结构性**的：写工具没有写的能力；
**不用 pi 的 `beforeToolCall` 拦**（`block` 会产生错误工具结果，模型会以为工具坏了反复
重试）。② 提案按 **`toolCallId`** 关联到消息（**不按执行顺序**：pi 默认并行跑同一轮工具）。
③ `POST /api/ai/confirm` 是**唯一真正落库的地方**，**只信 id 不信参数**：按 id 读回提案、
**重查一遍权限**，再走 `applyOps`。信客户端回传的 args 等于把权限判断交给浏览器。

**提案里存的是 `fields`（最终要落进 op 的字段），不是「意图」。** 其余约定见
[docs/业务模型.md](docs/业务模型.md)。

### 重复规则 / 逾期

- **防死循环的判据是「必须往前走」，不是次数上限**：`while (next && next < today &&
  next > cursor)`。曾经的 `guard < 800` 被证明是错的（2020 年起的「每天」要 2400+ 步，
  800 步就断，返回一个 2022 年的日期 —— **正是它本来要防的那个 bug**）。**别换回魔法数字。**
- **实例 id 是派生的**：`` `${根}#${发生日}` `` —— 两台设备离线推进会**派生出同一个 id**，
  同步时合并成一条。**这是整个同步模型里最要紧的一条不变量。**
- **逾期唯一口径**：`!done && date && date < today`。`counts().today` **不含逾期**。

---

## 三、界面硬规则（**跨切面**）

> 每条背后的像素与推导 → [docs/界面约定.md](docs/界面约定.md) 及 `-无障碍` / `-布局` /
> `-快速添加` 三份分册。**这里只留不许破的那一句。**

**交互统一是「列表 → 详情 → 编辑」三段式**（用户 2026-10-05 裁决）：点行 → 抽屉详情 →
从抽屉底部进编辑。删除走应用内确认弹层（`useConfirm`）。**界面上不出现「备忘录」「笔记
本」「清单」**；**脚本文案统一「打卡」不是「习惯」**（`habits` 数组名保留）。**深浅色两档**
（`ui.theme`）、**风格三档**（`ui.style` → `data-style` + `styles/tokens.css` 令牌块）。**色板
没有。图标一律 lucide，零 emoji；弹层一律应用内，零原生 `confirm` / `alert`。**

**令牌三条**：① **`.tsx` 里引用变量一律不给兜底值**（有兜底值时不报错、不白屏，只是两套
主题下全在用写死的浅色 —— **静默降级比直接坏掉难查得多**）。② **`--border`（装饰线，不要
求 3:1）与 `--input`（交互控件描边，≥3:1，WCAG 1.4.11）按「用户能不能操作它」分档**；焦点环统一在 `styles/responsive.css` 最末那条 `:focus-visible`，**必须和 `--input` 一起改**。③ **风格轴
两半**：线粗细走 `--border-w`，圆角走 `--r-xs/sm/md/lg/xl/pill`，**`.tsx` 里不许出现
Tailwind 自带的 `rounded` / `rounded-lg` / `rounded-2xl`**（写死的像素，切到 flat / notion
原地不动）。`contrast.mjs` / `color-scan.mjs` 锁着这三条。

**「哪些页面跨集、哪些按集」是定死的**（用户 2026-10-06 裁决）：今天 / 逾期 / 待办箱 /
垃圾箱看**全部**；日程 / 打卡 / 已完成只看**顶栏日程集多选勾着的那几个集**（`ui.cals`，
2026-10-08 从「只看当前集」改成多选，2026-10-09 从侧栏移到顶栏下拉多选 + 移动端「更多」
抽屉里的多选弹窗）。表达方式是 `App.tsx` 给这几个视图传**哪一份 state**
（`state` 全量 / `scoped`）—— **不要**给 views/ 里的选择器加 `calId` 参数。
**侧栏徽标与顶栏一律用全量口径。**

> **勾选（`ui.cals`）和归属（`ui.cal`）是两件事**：前者是「我想同时看哪几个」，
> 后者是「新建的东西落哪儿」（必须是**一个**）。`store.toggleCal()` 保证归属的集
> 一定勾着 —— 否则新建的东西会落在看不见的集里，用户看到的是「凭空消失」。
> 所以**至少永远有一个集是勾着的**，想只看某一个就取消勾掉别的。

**只读成员看到的不是「藏起来」，是「点了会告诉你为什么」**（`commitMany()` 挡下时
`denied` +1，弹一次提示，**别让写操作静默失败**）。记录只有 `store.ts` 的 `deny()` 一个
入口；**提示要点名是哪个集**（`deniedCals`）—— 今天 / 逾期 / 待办箱是跨集的。

### 变量名不许写错，也不许给兜底值

**断网时界面也必须说话**：顶栏显示 ☁︎ 划掉配「离线，改动先存在本机」，**不是**那个一直转的
加载圈。来源是 `useOnline()`，**不是**「上次请求成不成功」。**有登录，但没有密码找回、
没有邮箱、没有第三方登录，也没有管理员。别在界面上提「管理员」**（`users.is_admin` 已经
没有了）。

**无障碍四条**：① 每个控件都要有可访问名字（`<label htmlFor>` / `aria-label` /
`<IconBtn label>`），**`placeholder` 不算名字**；② 勾选圈一律走 `views/parts.tsx` 的
`<CheckBtn>`；③ **命中区 ≥24×24（WCAG 2.5.8）但视觉尺寸不变**；④ 盖住整页的浮层必须同时
做四件事 —— `role="dialog"` + `aria-modal` + 名字 · `useFocusTrap` · 开时焦点送进**面板
本身**（送进第一个输入框会**当场弹手机软键盘**）· 关时还回原处。

**状态语义三个别混用**：`aria-current="page"` 用「现在在哪一页」；`aria-expanded` 只给
**真的是折叠开关**的；`aria-haspopup="dialog"` 给「按下去弹浮层，但开没开的状态在 App
那层」的。**`prefers-reduced-motion` 全站关，只有 `.animate-spin` 例外**（通配 `*` +
`!important`）—— 会动的地方十几处，**挑漏一处等于没关**。

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
| 没有可见标签的控件（`Chips` / `SheetPicker` 这类按钮组） | `aria-label` 或 `aria-labelledby` | 管理浮层那两个角色 `Chips`、抽屉的「项目」`SheetPicker`、邀请用户名框 |
| 只有图标的按钮 | `<IconBtn label="…">`（`ui/kit.tsx`） | 抽屉的关闭、各类「删除 / 移出」 |
| 有文字的按钮 | 什么都不用加 | 可见文字**就是**它的名字 |

> **`placeholder` 不算名字** —— 它输入后就没了。这一条踩过：探针本来接受
> placeholder，于是管理浮层那个「名字」框**整整一轮没被任何断言看过**。
> 这条规矩是踩出来的，**不随探针存废**（`browser-smoke.mjs` 2026-10-15 已删）：
> 以后再写探针，取可访问名字的函数也**不许接受 placeholder**，别再加回去。
> `placeholder` 只给格式示例（如「10月15日」「学英语」），**不当可访问名字**。

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
> `.drawer:focus-visible` / `[role="dialog"]:focus-visible` 在 `styles/responsive.css` 末尾
> **关掉焦点环** —— 必须写在 `styles/responsive.css` 里：Tailwind 的 `outline-none` 在 `@layer`
> 里，压不过它（见[踩坑 17](docs/踩坑.md)）。

### 状态语义：`aria-current` / `aria-expanded` / `aria-haspopup`（2026-10-06）

这三个各有各的场合，**别混着用**（`aria-expanded` 摆在只是弹浮层的按钮上，
读屏会念成「已折叠」—— 那里根本没折叠这回事）：

| 属性 | 用在哪 | 判据 |
|---|---|---|
| `aria-current="page"` | 侧栏 `.nav-item`、底部标签栏 `.tab` | 「现在在哪一页」 |
| `aria-expanded`（+ `aria-controls`） | 「今天已完成」的 `.td-head`、「找日期」的 `.jump-btn` | **真的是个折叠开关** |
| `aria-haspopup="dialog"` | 邀请收件箱 / 找日期 / 日程集多选（顶栏 `.cal-menu-btn`） | 按下去会弹一个浮层，但开没开是 App 那一层的状态 |

> 后两个的差别就是「开没开这个状态**在谁手里**」。

### 降低动态效果：全站关，只有「正在同步」例外（2026-10-06）

`styles/responsive.css` **文件最末**一段 `@media (prefers-reduced-motion: reduce)`：
通配 `*` + `!important` 把 `animation-duration` / `transition-duration` 压到
`.01ms`、`scroll-behavior` 复位。

- **为什么不挑几个「大动作」**：会动的地方有十几处，挑漏一处就等于没关，
  而且日后再加一处也不会有人记得回来补。
- **唯一的例外是 `.animate-spin`**（同步中的加载圈）：它不是动效，是在说
  「正在同步，别以为卡死了」。停下来传达的正好是相反的意思。
- 这一条必须**压得过内联 style 和 Tailwind 层**，所以 `!important` 不是偷懒。

---

## 四、最容易翻车的十条

> 完整 49 条见上面那三份 `docs/踩坑*.md`。这十条最常踩、症状最会骗人。

1. **两个 Service Worker 会打架** —— 「注销作用域内所有 SW」会把自己刚注册的也干掉。
   拆旧 SW 用 localStorage 标记锁成**一次性**；删缓存只认 `/^schedule-v\d+$/`，
   **新版 `sched-shell-*` 不能删**。（[踩坑 1](docs/踩坑.md)）
2. **LWW 逐字段；幂等不靠 oplog**（比较键 `(ts, deviceId)` 创建时固定，重放一行不改）；
   **时间戳只拒绝、不钳制** —— 钳制值取决于「收到请求那一刻」，重放会钳出两个值。
   （[踩坑 3](docs/踩坑.md)）
3. **拖动排序用「让位洞」模型，不是插入线**。位置一律按 dragstart 量的 `rawLayout`，
   **不能用实时坐标**（让位是加在元素上的 `transform`）。（[踩坑 6](docs/踩坑.md)）
4. **拖拽统一走 @dnd-kit 的 PointerSensor**（[踩坑 12](docs/踩坑.md)）
   鼠标和触摸由 `PointerSensor` 统一处理，不再需要两条输入通路。
   `activationConstraint: { distance: 8 }` 替代了原来的 `TOUCH_SLOP`。
   长按 → ActSheet 流程保留在 App.tsx，与 dnd-kit 的 `onDragStart` 协调。
5. **CSS 层叠两条**：同特异度后写的赢（给折叠元素加类要查 `display`）；Tailwind 4 全在
   `@layer` 里，**没有层的作者样式永远赢** —— 代价是 legacy 覆盖过的元素上工具类
   **不生效**。（[踩坑 17](docs/踩坑.md)）
6. **工程目录在 SMB 上，偶发丢文件**：大文件先写本机再 `cp`，`md5sum` 两端核对；
   **别用 `perl -i` / `sed -i`**（靠「写临时文件再改名」，改名失败**原文件当场消失**）。
   （[踩坑 21](docs/踩坑.md)）
7. **解析器规则顺序不能重排**：**「重复」整组必须在「日期」整组之前**（否则「每周一」
   被当成「周一」）；`大后天` 在 `后天` 前、`下下周一` 在 `下周一` 前。
   （[踩坑 25](docs/踩坑.md)）
8. **`waitFor` 只吃表达式、`evalJs` 要自己 `return`**：前者不能以换行开头（ASI 会把
   `return` 断成空语句）；后者不会替你补 `return`。**规矩：`evalJs` 一律写 `return …;`。**
   （[踩坑 29](docs/踩坑-环境.md)）
9. **行尾一律 LF**，`.gitattributes` 的 `* text=auto eol=lf` —— **`eol=lf` 不能省**，
   否则 `core.autocrlf=true` 的机器检出时又写出 CRLF。（[踩坑 36](docs/踩坑.md)）
10. **跑完测试必须收干净**：`pkill -x chrome` 确认归零、`ss -ltnp` 找出残留服务 `kill`。
    探针的四个端口**首选被占会自动让开**（起手那行「端口：…」写着这趟实际用了哪几个），
    但**避让只管这一趟** —— 撞着的那一趟照样占着端口不放，而且新起的会静默失败、
    转去连残留的旧后端（实测报注册 409，完全指错地方）。
    （[踩坑 40](docs/踩坑-环境.md)）

---

## 五、给 AI 的硬约束

1. **后端只许引 AI 那一组依赖，别的一律不许**，其它全用 Node 标准库。零依赖在 2026-10-06
   被用户明确推翻（原话：*「不要守着 0 依赖，那个没有意义」*），为的是接 pi 而不是手搓
   工具循环。**这是有范围的让步，不是「以后随便引」。** 现状：
   `@earendil-works/pi-agent-core` + `pi-ai`，锁精确版本（没到 1.0），装在本机磁盘，
   **pi 的调用只关在 `server/lib/ai/chat.mjs` 一个文件里**。
2. **不引入 `v1` / `v2` 版本号并存** —— 结构变了就归档旧 key + 写迁移。
3. **不改 nginx 的路径结构**（没有 `/schedule2/`），回滚靠换 `dist/`。
4. **前端新依赖要先问** —— `app/package.json` 里 11 个，每个都是「现有视觉做不到才加的」。
5. **`domain/` 保持纯净**（不含 React / DOM / 网络），它要能在 Capacitor 与 Node 里跑。
6. **别在文档里写密码。**
7. **权限判断只在 `canWrite` / `canManage` / `db.roleOf()` 三个入口。**

---

## 六、部署

`cd app && npm run build` → 前端产物落 `../dist/`，刷新即生效；改了后端才需要
`systemctl --user restart schedule-backend`。**完整细节（nginx、systemd、备份、回滚、
排障）在 [DEPLOY.md](DEPLOY.md) 及其四份分册。**
