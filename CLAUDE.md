# 日程清单

个人用的任务与打卡网页。记「要做什么、哪天做、做多久」，日 · 周 · 月三视图。
纯前端，**数据存在你当前浏览器的 localStorage 里，不上传服务器**。

**面向使用者 → 本文**
**部署与运维 → [DEPLOY.md](DEPLOY.md)**
**面向 AI 辅助开发（本文档）→ 你在这里**

| 文件 | 读者 | 内容 |
|---|---|---|
| `README.md` | 人 | 网址、怎么用、数据在哪、日常命令、故障排查 |
| `CLAUDE.md` | AI 编码助手 | 数据模型、代码约定、踩坑记录 |
| `DEPLOY.md` | 人 + AI | nginx 怎么操作、conf 怎么写、发布流程、已知会踩的坑 |

改代码前先读「三、业务模型」和「五、界面约定」——那些约束都是踩坑换来的。
改 nginx 配置或发布流程前读 [DEPLOY.md](DEPLOY.md)。

---

## 一、当前结构（纯静态，无构建）

应用是**无构建的纯前端**：源文件即产物，`index.html` 用普通 `<script>` 标签按
`store → parse → views → clock → app` 顺序加载，顶层 `var` 共享全局。

```text
日程管理/                        前端源码（= 部署产物，无构建）
  index.html          结构：侧栏 / 顶栏 / 时间轴容器 / 抽屉 / 标签栏 / 浮层
  styles.css          全部样式（约 67 KB）
  store.js            数据层：模型 + localStorage 持久化 + 增删改查（U 与 DB 两个全局）
  parse.js            自然语言解析：日期 / 时间 / 时长 / 重复
  views.js            渲染：日 / 周 / 月三视图 + 六个列表页
  clock.js            12 小时制时钟选择器（IIFE，挂 window.Clock）
  app.js              交互：渲染调度、拖拽、拉伸、快捷键、浮层（约 1730 行）
  sw.js               Service Worker：网络优先，断网回落缓存
  manifest.json       PWA 清单（scope 与 start_url 都是 ./，锁在 /schedule/）
  icon.svg            图标
│
tools/sync-dist.mjs  零依赖脚本：把上面 10 个文件白名单复制进 dist/
dist/                部署产物（生成物，勿手改；nginx 只伺服这里）
  BUILD.txt          构建清单 + 每个文件的 sha256 短哈希
deploy/schedule.conf nginx 配置的本地副本（服务器上还有一份真正生效的）
tests/               无头 Chrome 探针脚本（CDP），见 tests/README.md
  list-assert.mjs    可拖列表落点断言（主断言，退出码 1 = 有问题）
  drop-*.mjs         上一代模型的断言 / 扫描 / 截图
  allday-assert.mjs  日视图未定时区（另一种容器结构）
_refactor/           未启用的 React + TS 重构骨架，见其 README
CLAUDE.md  DEPLOY.md  README.md
```

> **刻意不用 ES module**，是 2026-10-04 的选型决定：应用要能**双击 `index.html`
> 直接打开**，`file://` 下 ES module 会被 CORS 拦掉。代价是没有依赖注入与打包，
> 换来的是零构建、零依赖、双击即用。

> **`app.js` 是 IIFE**（`(function () { ... })()`），内部 `parseJumpText` /
> `applyTheme` / `renderAll` 等闭包函数**外部不可见**。要测它们只能走真实 UI 路径
> （填输入框点按钮），直接调会 ReferenceError。

脚本顺序有依赖：`store.js` 定义 `U` / `DB`，`views.js` 用它们，
`app.js` 最后把它们串起来。改顺序会白屏。

### 命名与路径：没有版本号

```text
网址        https://home.xiaokubao.space/schedule/
数据 key    localStorage 的 schedule-app-v1（DB 状态）+ schedule-app-notes-archive（旧备忘录归档）
构建        node tools/sync-dist.mjs → dist/（不是 vite build）
缓存名      sw.js 里的 schedule-v12（CACHE 常量）
归档 key    data.v1 / data.v2 —— 不存在，本项目没有接口也没有版本化结构
```

**不要引入 `v1` / `v2` 这类版本号目录并存。** 换结构时归档旧数据、改代码，
别用 vN 并存。

### `_refactor/` 是什么

2026-10-05 上午曾尝试把应用重写成 React + TypeScript，产物存放在 `_refactor/`：
数据层约 1279 行（`types.ts` / `date.ts` / `store.ts` / `parse.ts` + 首个单测），
**没有任何组件**，`npm run build` 必然失败。根目录的 `package.json` /
`vite.config.ts` / `tsconfig.json` 与 `_refactor/` 里的逐字节相同，是同一批脚手架。

数据模型照着已定稿的设计写，是整个重构里最不返工的部分，所以留着没删。
**它目前完全没有被使用**，部署走的仍是根目录的纯静态版本。

> **根目录的 `package.json` 目前是「摆设但无害」的** —— 它的 scripts 指向
> `src/lib/*.test.ts` 与 `tests/integration.test.ts`，而这两处**都不存在**，
> 所以 `npm test` 会因为 glob 无匹配而无输出通过（实测 `# fail 0`）。
> 改成 `test:*` 会因为 `node_modules` 没有 `tests/node-resolve-ts.mjs` 而报错。
> 真正要跑测试时先 `npm install` 再补齐那三个文件。**别把这个「通过」当成测试在跑。**

---

## 二、业务模型（**最要紧的部分**）

### 工具分工：这是一个纯任务管理应用

用户既定：滴答清单位 = 有日期 / 要行动的任务；系统笔记 = 长篇幅记录；
系统备忘录负一屏 = 无任务属性的提示。**本项目不做长篇幅记录。**

备忘录 / 清单（lists）/ 笔记本（notebooks）三个模块已整体删除，
`normalize()` 会把旧数据里的 `notes` + `notebooks` 折进 `archive` 并转存到
`schedule-app-notes-archive`，然后 `delete` 掉原键。**别再加回来。**

### 数据结构

```js
{
  version: 3,
  tasks: [{
    id, title, note,
    date: 'YYYY-MM-DD' | null,   // null = 待办箱（未定日期）
    time: 'HH:MM' | null,        // null = 未定时
    duration: 分钟（默认 60）,
    done, doneAt,
    repeat: { unit, n, weekdays, monthday, end },
    repeatSeq,                   // 已推进次数，用于 end.type='count'
    order,                       // 同一天未定时的手动顺序位
    createdAt, source
  }],
  trash: [{ id, kind, payload, from, groupId, deletedAt }],  // 软删除
  habits: [{ id, title, order, log: { 'YYYY-MM-DD': true }, createdAt }],
  ui: { nav, view, cursor, theme, search, navOrder, navBottom, tdoneOpen },
  archive: { notebooks, notes, archivedAt }   // 旧备忘录，只导出时带上
}
```

**任务与打卡是两个独立模块**，互不混入：任务走 `tasks` 数组、打卡走 `habits`，
`habits` 的 `log` 是按日期的稀疏映射，没有 `date` / `time` / `duration` 字段。

**待办箱 = `date === null` 的未完成任务**（`counts().inbox`）。未定时是另一回事：
`date` 有、`time` 为空，落在时间轴上方的全天区。

**三态各自独立**：未定时任务（`time===null`）· 未定日期任务（`date===null`）·
已完成但仍占时间段（`done && time`，灰显留在时间轴上）。
只有第二态进待办箱。

### 重复规则

`repeat` 对象化（2026-10-05 升级，旧数据里的字符串 `'weekly'` 由 `U.toRepeat` 转换）：

```js
{ unit: 'none'|'day'|'week'|'month'|'year', n: 1,
  weekdays: [],          // unit='week' 时生效，空 = 沿用原日期的星期
  monthday: 原日期的日号, // unit='month' 时生效（31 号在 2 月会被截到月末）
  end: null | { type:'date', date } | { type:'count', count } }
```

推进逻辑在 `DB.repeatNext()` / `DB.repeatAdvance()`：
**勾选完成时若下次发生日在今天之前，会一路补到今天之后**（`guard < 800` 防死循环），
并在 `repeat.end` 允许时新建一个实例（`repeatSeq + 1`）。

`repeatNext` 里那个 800 次的 guard 看着魔法数字，其实是必要的：
一个「每天重复、结束日期在三年前」的任务不补齐就会每次勾选都创建一个过去的实例。

> **`repeat.monthday` 与 `task.date` 要分开看。** 每月 31 号的任务在 2 月
> 会被 `repeatAdvance` 截到月末（`Math.min(day, last)`），但 `task.date` 仍是 31 号。
> 改重复规则时别用 `task.date` 反推 `monthday`。

### 逾期

`DB.overdueCount()` 是**唯一口径**：`!done && date && date < today`。
`counts().today` 只算当天，**不包含逾期** —— 2026-10-05 明确拆开，
之前混在一起导致同一任务在两个徽标里各数一次。

逾期页按原定日期分组，组标题写「逾期 N 天」，每行带 今天 / 明天 / 改到… 三个快捷改期。
「改到…」用离屏 `<input type="date">` + `showPicker()`，不走完整抽屉，
元素用 `setTimeout(remove, 60000)` 兜底清理。

### 首次打开的演示数据

`store.js` 的 `DB.seed()` 只在 localStorage 为空时生成一份 7 条任务 + 3 个打卡的演示数据
（团队早会 / 整理季度汇报大纲 / 取快递 / 牙医复诊 / 交房租 …）。删掉后不会再出现。
用户报「怎么有别人的任务」时先查这个，不是数据污染。

---

## 三、本地开发

**无构建，改完刷新即生效。**

```bash
# 方式一：直接双击 index.html（file:// 也能跑，这是刻意支持的用法）
# 方式二：起个静态服务器，更接近线上
cd dist && python -m http.server 8899   # → http://127.0.0.1:8899/
```

> **本地预览用 `dist/` 更好**，因为那才是线上真正伺服的内容 ——
> 直接开根目录的 `index.html` 会绕过 `sync-dist.mjs` 的白名单校验，
> 也能跑，但和线上不是同一份文件。

改完代码要上线：

```bash
node tools/sync-dist.mjs
```

### 测试

没有正式测试框架。`tests/` 下是无头 Chrome 探针脚本，纯 Node + CDP 驱动真实 Chrome、
零 npm 依赖。**怎么跑、判定标准、演进历史见 [tests/README.md](tests/README.md)** —— 
那一节更详细，改测试前先读它。

跑法是**先起静态服务器，再另开终端跑脚本**（脚本不自己起，避免端口打架）：

```bash
python -m http.server 8901          # 终端 1，工程根目录
node tests/list-assert.mjs          # 终端 2，可拖列表全量断言（主断言）
```

`list-assert.mjs` 与 `allday-assert.mjs` 是断言脚本，**有问题时退出码为 1**。
其余是扫描 / 截图脚本，供人眼核对。

结果经 `localStorage` 或 CDP `evaluate` 传出（`file://` 下 postMessage 被拦）。

> **脚本头部写死了 Windows 绝对路径**（Chrome、`python.exe`、工程根目录）。
> 在这台 Linux 机器上跑要先改那三处常量。

**无头 Chrome 有最小窗口宽度约 526px**，`--window-size=390` 量不到真手机宽度。
必须用固定宽度的 iframe 包住应用（`tests/drop-scan.html`）。
其余探针坑见「四、21」与「四、24」。

> 根目录 `package.json` 的 `npm test` **当前是空转**：scripts 指向 `src/lib/*.test.ts`
> 与 `tests/integration.test.ts`，两者都不存在，glob 无匹配就「通过」。
> 别把这个当测试在跑 —— 详见「一」末尾那条。

---

## 四、踩过的坑（改代码前先看这里）

**1. 改了代码但浏览器没生效 → 先怀疑 Service Worker**

`sw.js` 的 `CACHE = 'schedule-v12'`，网络优先 + 离线回落。排查时先清：

```js
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
```

> 强制刷新（Ctrl+Shift+R）通常就够。`sw.js` 本身在 nginx 里配了 `no-store`
> （见 [DEPLOY.md](DEPLOY.md)），正常不会卡在旧 SW 上。
> **改 `sw.js` 或 `index.html` 本身时要把 `CACHE` 加一**，否则 `activate` 里
> 删旧缓存的那步不会触发 —— 其余资源本来就是网络优先，改它们不用动版本号。

**2. `data-drop` 必须挂在有 padding 的元素的祖先上**

这是「有的任务拖不动」的真正根因，踩过两次。`data-drop` 原先挂在**内层**
`.allday-items` 上，而它有 `padding`：拖到 padding、任务之间的空隙、容器边缘时
`e.target.closest('[data-drop]')` 找不到 zone，`dragover` / `drop` 直接 return，
**静默失败，无任何报错**。用户感知就是「有的能拖、有的不能」。

修法：`data-drop` + `data-date` 上移到最外层 `.allday-zone`，内层纯做布局。

**3. 拖动排序用「让位洞」模型，不是插入线**

拖动时其他任务**实时地、平滑地挪开**，在光标处留出一个占位洞 `.drop-hole`，
落点由「洞在哪」直接表达。位置本身就是位置，不用一条线去暗示。

之前是「静态插入线 + 目标格描边」，视觉上对，但拖起来是「刻板」的：
线条只在跨过格子边界时跳一下，中间一大段位移完全没有反馈，眼睛得盯着线猜。
**不要再退回插入线模型。**

关键取舍：**不用 FLIP（先量后补 transform），而是直接改 DOM 顺序 + CSS transition。**
HTML5 拖拽里每帧改 DOM 顺序代价太高，而且 transition 会和 dragover 的重排互相打断。
实测 160ms 缓动就足够顺，逐帧插值反而更黏。

四个辅助函数（都在 `app.js`，落点判定那段开头的长注释解释了演进过程）：

| 函数 | 职责 |
|---|---|
| `zoneCells(zone)` | 按**视觉 row-major** 排出条目。含被拖元素自己（它确实占着格子）。不按 DOM 顺序 —— DOM 顺序等于 row-major 只在 grid 没改过 auto-flow 时成立 |
| `inferCols(cells)` | 按几何推列数：同一行里最多几个格子 |
| `cellUnder(e, cells)` | 找光标落在（或最近）的格子 |
| `refForIndex(cells, k)` | 把位次 k 翻译成排序接口要的 `(refId, pos)` |

**判定只看「光标落在哪一格」，不比较到各条线的远近。** 用「最近线段」会串行：
光标在格子中心时，上方那条线反而更近，于是整片区域被判成同一档，
左右拖动又变得没准头 —— 这正是「只有横线、左右全靠猜」的病根，换个画法并不能解决。
格子是用户真正能指的东西，「你指哪格，它就去哪」没有歧义。

**四条实现铁律**：

- **`left` / `top` 都得按容器坐标算。** 洞是 `position:absolute`，只设 `left` 的话
  它会一直停在原处 —— **DOM 顺序变了、落库也对，就是看不见**。这类 bug 很隐蔽。
- **只有落点真的变了才动 DOM 顺序。** `dragover` 每秒能触发几十次，
  每次都 `insertBefore` 会让让位动画一直重启，看起来反而更卡。
  用 `key = scope + '|' + k + '|' + cells.length` 去重。
- **移动洞时要绕开被拖元素**（`moveHole`）。否则洞会被塞到它旁边，
  出现「洞和被拖元素并排」的双份占位。
- **`clearHole()` 独立成函数**，与 `clearBusySrc()` 一样不要塞进 `clearDropUI()` ——
  后者每次 `dragover` 都会被调，会把标记立刻抹掉。

> `zoneCells` 按 `zone.dataset.kind === 'habit'` 在 `[data-habit]` 与 `[data-untimed="1"]`
> 之间切换 —— **打卡列表也走这套排序**，别以为只有任务列表能拖。

**落点相关的类名对照**（改样式前先认准当前用的是哪个）：

| 类 | 用途 | 状态 |
|---|---|---|
| `.drop-hole` | 占位洞（当前模型） | 在用 |
| `.drag-muted` | 让位开始后被拖元素淡出 | 在用 |
| `.tl-guide` | 时间轴落点线 + 时间徽章 | 在用 |
| `.tl-busy.drag-src` | 拖走时隐藏原位置的占用底纹 | 在用 |
| `.ins-line` / `.ins-bar` / `.ins-hl` | 旧插入线模型的残留 | **样式还在，但落点已不再创建** |

> `.ins-*` 那三个类目前只剩 `clearDropUI()` 里的清理代码还在引用它们。
> 那是防御性清理（万一有旧 DOM 残留），**不是当前模型的一部分**。
> 真要删干净，得连 CSS 和 `clearDropUI()` 里那三行一起删。

**时间轴落点仍是画线**（`.tl-guide`），没有改成洞 —— 时间轴是连续坐标不是列表，
「让位」在那里没有对应概念。这两种落点表达不要混。

**3b. 拖到视口上下缘会自动滚屏**

`runAutoScroll()` 用 `requestAnimationFrame` **持续**滚，不是在 `dragover` 里挪一点 ——
`dragover` 的触发频率跟着鼠标走，鼠标不动就不触发，滚动会一顿一顿的。
上下各 84px 进入滚动区（`EDGE`），最快每帧 17px（`MAX`），越靠边越快。

**滚完位置变了，落点必须按新位置重算**，否则洞会停在旧处 ——
用户明明看到列表已经滚到别处，指示却还指着原来那条。
`runAutoScroll` 里因此要保留 `dragProbe` / `dragProbeZone` 并重新调 `showDropGuide()`。

**4. 高度一律用 JS 实算，不要写 `calc(100vh - N)`**

浏览器工具栏、缩放、系统字号都会让那个 N 猜错（实测差 22px）。正确做法：

```js
var cs = getComputedStyle(el);
var avail = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
```

用它的两处：`Views.fitWeekHeight()`（写 `.week-view` 高度 + `--week-head-h`）、
`Views.fitMonthHeight()` / `Views.monthRowHeight()`。

`fitWeekHeight` 还负责写 `--week-head-h`（周视图表头的实测高度），
因为周视图未定时行的 `sticky` `top` 取的就是这个变量 —— 写死必错。

**5. 月视图必须能滚**

`fitMonthHeight` **只写下限**，不均分：`grid-auto-rows: minmax(下限, auto)`。
`auto` 让内容多的行自己长高 → `.content` 出现滚动条 → 滚轮可用。

早期版本把富余高度「均分」到 6 行强行铺满一屏，结果 1920×1080 下每行拉到 167px
却只塞 3 条任务（大片空白），而且刚好铺满时 `scrollHeight == clientHeight`，
**滚轮怎么滚都没反应**。旧函数 `Views.monthMetrics()` 已删除（它把行高和
「每格几条」绑在一起，反而限制了信息量）。

常量：`MONTH_ROW_MIN=104` / `MONTH_ROW_MAX=132` / `MONTH_HEAD_H=30` / `MONTH_CELL_MAX=8`。

> 「每格直接列出几条」**不写死**，超出的折叠成「还有 N 项」并加 `data-jump` 可点进那天的日视图。
> 上限不能太大：15 会把整行撑到几百像素、同行其他天全被拉空（实测截图确认）。
> 截断本身就是「看不到自己那格到底有什么」的根源 —— 只截 3 条时用户滚到那一行
> 才发现那天有 8 件事。

**6. 窄屏断点 900px，`isNarrow()` 与 CSS 媒体查询必须一致**

`app.js` 的 `isNarrow()` 用 `matchMedia('(max-width: 900px)')`，CSS 里对应
`@media (max-width: 900px)`。**改一处必须改另一处**，否则标签栏与侧栏的显隐会打架。

≤900px 侧栏收进「更多」抽屉，改用底部 `.tabbar`（今天 / 日程 / 待办箱 / 逾期 / 更多）。
**逾期必须留在底栏**（用户重视的功能，不能藏进「更多」）。
浮层 z-index 必须 > 标签栏的 45，否则抽屉被标签栏压住一截（现在用 60 / 61）。

> `styles.css` 里**另有** `@media (max-width: 820px)` 与 `(max-width: 640px)`
> 两处，那是排版微调（字号、间距），**不是**响应式断点，别混。

**7. 顶栏绝对不能加 `position` / `z-index` / `sticky`**

会生成层叠上下文，把里面的找日期面板（z-index 60）困住，导致被下方内容盖住变半透明。
实测踩过：窄屏下面板整个变半透明。窄屏下顶栏随内容一起滚反而省垂直空间。

**8. 触屏没有 hover，也没有 HTML5 拖拽**

- `@media (hover: none)` 处理 hover 才显形的元素（拖拽抓手、箭头、背景高亮）
- 排序 / 改期靠**长按 480ms 弹操作层**（`#actSheet`），`LONG_PRESS_MS = 480`。
  `pointerdown` 计时，`pointermove` / `pointerup` / `pointercancel` / `pointerleave` 取消，
  **只在 `pointerType !== 'mouse'` 时启用**（鼠标继续走拖拽）
- `longPressFired` 标志 + capture 阶段 click 拦截：长按生效后抬手那一下
  不会再顺带打开抽屉
- **动作值用无歧义前缀**：`dur60` 不是 `d60` —— 后者与 `del` / `date` 撞，
  靠 `+slice(1) > 0` 猜必然误伤。改动作值时按 `/^dur(\d+)$/` 匹配
- 窄屏下显式 `dragstart` → `preventDefault()`，避免某些移动浏览器模拟出半截行为

**9. `moveInList` 的候选列表不能排除自己**

原来的实现 `filter` 时把被移动的任务自己排除了，`findIndex` 恒返回 -1，
`refIdx` 永远是 0 → **「下移」永远把任务插到最前面**。
现在用含自己的 `all` 定位、用排除自己的 `list` 取参照。

**10. 浮层外点击收起要用 `mousedown` + capture**

`document.addEventListener('mousedown', ..., true)`。不用 capture 的话，
面板内 input 的 blur 会抢先把它关掉。

**11. 输入框不要在编辑时重建**

换掉 DOM 节点或改正在编辑的那个 input 的 `value` 会让光标跳到开头。
改提示文字 / 显隐改 class 或隐藏整块，别动那个正在输入的元素。

**12. 日期密度指示用淡底 + 底部短横，不要用 4px 圆点**

找日期面板与月视图的日期格：有未完成任务的格子加淡底 + 一条短横，
横宽按任务数分 3 档（`.lv2` / `.lv3` 控制）。**圆点 4px 在 1x 屏上几乎看不见**，
实测截图确认过。窄屏下月视图格子压成圆点（`font-size:0`）是因为那里塞不进文字，
与这里不是一回事。

**13. 时间轴方块是两行，短任务不渲染第二行**

`.tl-event` = `.ev-head`（勾选圈 + 标题）+ `.ev-time`（时间段）。
高度 < 46px 时**不渲染**时间行（15 分钟的短任务会被挤成两半）。
时间行样式明显弱于标题：`font-size: 10.5px` / `color: var(--text-3)`，
标题是 12.5px / text 色。

**14. 时间轴上下沿都可拖**

`.ev-resize` 是下沿、`.ev-resize-top` 是上沿（复用同一套样式）。
上沿拖动时 `ns = clamp(start + addMin, 0, end - 15)`，**底边固定**，
同时改 `time` 和 `duration`；下沿只改 `duration`。15 分钟步进。

> 测试时 `.ev-resize` **同时匹配上下沿** —— 用 `[data-act="resize-top"]` 区分，
> 否则会误判拉伸失效。

**15. 重叠任务按「重叠簇」分列**

`Views.layoutOverlap(events)`：先切成重叠簇（`e.start < cur.end` 并入，否则另起一组），
再在**簇内**贪心分列，每簇独立算 `cols`。

旧算法把全天所有事件塞进一个 `colEnds`，`cols` 取全天最大值，
于是**任何**一段重叠都会让当天所有方块一起变半宽 —— 不重叠的任务也跟着变窄。
日视图与 `weekTimed()` 共用此函数，占用底纹与方块宽度严格一致。

> **占位底纹 `tl-busy` 必须与方块同列宽**（`left: e.col*w%` + `width: calc(w% - 4px)`）。
> 原来 `left:0; right:0` 整条铺满，两个穿插任务叠在一起时整段时间被染色。

**16. 已完成的未定时任务不占日程位置**

`Views.untimedOn(iso)` = `!t.time && !t.done`，日 / 周视图共用。
已完成的**定时**任务仍留在时间轴上灰显 —— 它占着具体时间段，抹掉会丢失
「那段时间做过什么」。

「今天」页有可折叠的「今天已完成」区块（`Views.todayDoneBlock`，
状态存 `ui.tdoneOpen`，默认收起）。在里面取消勾选会让任务自动回到日程页。

**17. 侧栏顺序可拖动，`normalize` 必须区分 undefined 与空数组**

状态存 `ui.navOrder`（全局顺序）+ `ui.navBottom`（哪些归底部 `#navBottom` 组）。
`#nav` 与 `#navBottom` 是两个容器，垃圾箱可以被拖进主区，反之亦然。

> **`navBottom` 不能用「空则默认 `['trash']`」的写法** —— 那会把用户主动拖出底部的
> 垃圾箱又塞回去。必须区分「从未设置（undefined）→ 给默认」与
> 「空数组 → 用户有意为之，原样保留」。

其他坑：浏览器 `dragend` 后可能补一次 `click`（用 `navJustDragged` 标志 +
`setTimeout(…, 0)` 吞掉）；`renderSidebar` 的 active 高亮要用统一的 `$$('.nav-item')`
取，不能分开写 `#nav` 与 `#navBottom`。

**18. CSS 层叠：同特异度后写的赢，给折叠元素加类要查 display**

`.habit-list { display:flex }` 声明在 `.mc` 之后会覆盖 `display:grid`。
同特异度下后写的赢，必须补 `.habit-list.mc { display:grid }` 提一级特异度。

`.td-body` 收起时 `display:none`，但 `.mc { display:grid }` 在后面会把它强制变成 grid
→ **折叠的「今天已完成」区块凭空展开**。必须补
`.today-done .td-body { display:none }` +
`.today-done.open .td-body.mc { display:grid }`。

> 规律：**给折叠 / 隐藏元素加类时，一定要检查该元素的 `display` 规则与新类的层叠顺序。**

**19. `.mc` 是显式加的类，不是靠 CSS 猜子元素**

宽屏列表分列靠 `.mc`。它加在：待办箱 `.group-items`、今天主列表、
已完成 / 逾期 / 垃圾箱的每个分组内部、打卡 `.habit-list`、「今天已完成」明细。
整块内容（打卡条 `.checkin-strip`、逾期提示 `.od-strip`、`.today-done`、
`.trash-head`、`.habit-add`、`.empty`）用 `grid-column: 1/-1` 排除分列。

断点：1120px→2 列 / 1560px→3 列 / 2000px→4 列 / 2560px→5 列。
分列后 `.mc > .task-row/.habit-row` 的 `margin-bottom` 要清掉，改用 grid `row-gap`。

> 重复的 `max-width` 声明要合并 —— `.habits-view` 在文件更靠后有一份，
> 会赢过前面媒体查询里的那份。

**20. 原生 `confirm()` 在 PWA 里会被静默吞掉**

用原生 `confirm()` / `alert()`，PWA 环境会**直接返回 `false`** ——
表现为「点了删除完全没反应」，用户看不到任何提示，代码却以为他点了取消。

> **但当前 `app.js` 里有 4 处仍在用 `confirm()`**（永久删除、清空垃圾箱、
> 删除打卡习惯、导入备份覆盖）。桌面浏览器正常，装成 App 后会静默失效。
> 改这几处时换成应用内确认弹层（`<div class="sheet-mask">` + 浮层，
> 参考 `#actSheet` 的结构），**别再用原生 confirm**。

**21. 测试探针的坑（照抄即可）**

- 注入的脚本**后缀必须是 `.txt`**。`.js` 会被 MIME 猜测当 HTML 解析，报 `Unexpected token '<'`
- 用 `document.body.textContent` 搜中文会命中内联 `<script>` 源码本身，
  导致「已删除的文案仍存在」的假阳性 —— 改用 `document.getElementById('content').textContent`
- 合成 `DragEvent` 时 `target` 默认是派发元素（`content`），
  `e.target.closest('.task-el')` 找不到 → 派发前
  `Object.defineProperty(ev, 'target', { value: 真实元素 })`
- **不要在测试脚本里写 `location.reload()`**：内联脚本随页面重新执行 → 无限刷新，
  headless Chrome 挂住只能 taskkill。验证「刷新后还原」要在同一页里手动重建 DOM 再调函数
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
- 合成事件后调用了会触发 `renderAll` 的操作（如 drop），
  后续测试必须**重新 querySelector**，旧引用指向已脱离文档的节点，`getBoundingClientRect()` 全是 0
- 无头 Chrome 截图要 `--ignore-certificate-errors`
- 无头算「本周内某一天」时用 `U.weekStart(today)` 再偏移，
  不要直接 `today+2`，否则跨周时列不存在会拿到 null

**22. 解析器的规则顺序不能重排：重复必须在日期之前**

`parse.js` 的 `rulesOf()` 返回的数组顺序是有意义的，注释里写了原因：
**「每周一」如果不先被重复规则吃掉，会被后面的日期规则当成「周一」解析成某个具体日期。**

同理还有几处顺序敏感：

- **「重复」整组必须在「日期」整组之前。** `每` / `每周` / `每月` / `工作日` 都是前缀触发词。
- **`大后天` 必须排在 `后天` 前面**，否则先匹配到「后天」。
- **`下下周一` 必须排在 `下周一` 前面**。
- **完整日期必须在「N号/N日」之前**，否则 `15` 被单独吃掉。

规则靠**顺序 + `ctx.isolated` 双重把关**识别片段：
`ctx.isolated` 要求匹配片段**前后都是词边界**（前面是行首或空格，后面是行尾或空格），
用来避免「有三点要说明」里的「三点」被误判成时间 03:00。

> 口语里不带时段修饰的「3点」多半指下午，所以 `h < 8` 会自动 +12。
> **但只有「整段独立成词」时才这么做**（`if (mi === 0 && !ctx.isolated) return null`）；
> 带「半 / 刻 / 分」时信号足够强，不需要独立成词。
> 改这条逻辑时注意它同时影响「三天后」这类相对日期的解析。

**23. 窄屏的负载文字要用 `shortLoad`，不要用完整时长**

月视图格子窄（53px 宽），完整文案「3小时45分」会**折成三行把日期数字挤扁**。
`Views.shortLoad(mins)` 是专门给窄屏的：`225 → 3¾`、`60 → 1时`、`45 → 45分`。

只有宽屏才用完整的 `U.fmtDuration`。改文案时先确认是哪个视图在用。

**24. 无头 Chrome 有最小窗口宽度约 526px**

`--window-size=390` 实测 `innerWidth` 是 526，量不到真手机宽度，截图也会被裁。
**解法是用一个固定宽度的 iframe 包住应用**，iframe 内部才是真实的 390px 视口，
外层窗口给 560px（`tests/drop-scan.html`）。其余测试坑见上一条。

**25. 改 nginx 配置在本机直接 cp，别 ssh 自己**

这台机器（`ubuntu`，`192.168.1.6`）**就是 nginx 所在的服务器**，
工程目录也在本机。所以改 `deploy/schedule.conf` 后直接：

```bash
cp deploy/schedule.conf ~/docker/nginx/conf.d/home/schedule.conf
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

> **别写 `ssh nas`** —— `~/.ssh/config` 里没有 `nas` 这个别名
> （本机叫 `ubuntu` / `fn`），在本机上执行会报 `Could not resolve hostname nas`。
> `nas` 是 Windows 侧连过来时的名字，且那边 `scp` 传中文路径会失败，
> 要从远程改就用 `cat 文件 | ssh ubuntu "cat > 目标"` + `md5sum` 校验。

---

## 五、界面约定

**交互统一是「列表 → 详情 → 编辑」三段式**（用户 2026-10-05 裁决）。
任务一律走这条路：点行 → `drawer` 详情 → 从抽屉底部进编辑。

删除走应用内确认弹层，正文要写清连带后果。**当前有 4 处用了原生 `confirm()`，
见「四、20」—— 改这几处时顺手换掉。**

**界面上不要出现「备忘录」「笔记本」「清单」的字样。** 三个模块已删除，
旧数据折进 `archive` 只参与导出。

**脚本身份统一是「打卡」不是「习惯」。** `habits` 数组名保留（数据结构），
界面文案一律「打卡」，侧栏 `data-nav="habits"` 的 label 写「打卡」。

**今日进度的三个数字要同源**：侧栏 `.side-pulse` 与「更多」抽屉 `.ms-pulse` 显示
今日完成比例，三处都从 `DB.counts()` 取值，`>99` 显示 `99+`。

**金额相关一律不适用**（本项目没有金额字段，`U.fmtMoney` 是遗留函数）。

> `U.fmtMoney` 在 `store.js` 里定义但**当前没有任何调用点**。别因为它存在
> 就以为项目有金额概念。

**深浅色只有 light / dark 两档**，存 `ui.theme`，顶栏 `#themeBtn` 切换。
**没有多套风格 / 色板** —— 那是账本项目的机制，本项目没有，别照抄。

**没有登录、没有密码、没有服务器端数据。** 与账本项目的核心区别。
写文档或代码时别把账本那套鉴权、SQLite、JWT 搬过来。

---

## 五·补、针对 AI 的三条硬约束

1. **不要引入构建步骤。** 应用必须能双击 `index.html` 直接打开。
   引入 Vite 就废掉了这个刻意支持的用法（除非重构成 React，那是另一件事，见 `_refactor/`）。
2. **不要引入依赖。** 现在 `node_modules` 根本不存在，五个 JS 是零依赖的。
   需要什么先看标准库。
3. **不要引入 `v1` / `v2` 版本号并存。** 数据结构变了就归档旧 key + 写迁移。

---

## 六、部署

```bash
node tools/sync-dist.mjs     # 白名单复制进 dist/，刷新页面即生效
```

**没有重启步骤。** `dist/` 是 NAS 共享目录，nginx 直接读它。改 nginx 配置才要 reload。

**部署与运维的完整细节在 [DEPLOY.md](DEPLOY.md)** —— 证书、conf 怎么写、
回滚、迁移到新机器。改 nginx 配置或发布流程前先读它。