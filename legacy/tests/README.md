# tests —— 拖放落点测试

验证「拖动时指示物指的地方」和「任务实际落点」是不是同一件事。
纯 Node + CDP 驱动真实 Chrome，零 npm 依赖。

## 怎么跑

先在工程根目录起个静态服务器（脚本不会自己起，避免端口打架）：

```bash
python -m http.server 8901
```

然后另开一个终端：

```bash
node tests/list-assert.mjs 1430x900     # 可拖列表全量（让位洞模型，主断言）
node tests/allday-assert.mjs 1430x900   # 日视图未定时区（另一种容器结构）
node tests/shift-overlap.mjs            # 让位重叠自检（多视口，见下）
node tests/col-check.mjs                # 列数断言：电脑版一行最多 2 个
node tests/view-smoke.mjs 1920x900      # 日/周/月 + 各列表冒烟 + 横向溢出
node tests/shot-shift.mjs               # 让位动画关键帧截图（肉眼确认「丝滑」）
node tests/drop-assert.mjs 1430x900     # ⚠️ 依赖废弃的线条模型，会假通过
```

前四个是断言脚本，**有问题时退出码为 1**，可以直接接 CI。
都接受视口参数，用来覆盖单列 / 双列 various 断点。

> **一次只能跑一个。** 连着跑会撞 CDP 端口，表现为「Chrome 没起来」。
> 前一个跑完先 `taskkill /F /IM chrome.exe`，等 2 秒再起下一个。

`shot-shift.mjs` 会把拖动过程的关键帧截到 `%TEMP%\sched-shots\`，
并打印每个格子的实时坐标 —— 断言只能证明「位置对不对」，
证明不了「动得顺不顺」，这部分得用眼睛看。

> **脚本路径是 Windows 绝对路径**（Chrome、`python.exe`、工程根目录都写死在各脚本头部）。
> 在这台 Linux 机器上跑要先改这三处常量。

## 判定标准

拖放该满足的是一句话：**你指哪格，它就去哪。**

`list-assert.mjs` 用「让位洞」模型，判据比指示物更干净 ——
不需要推断「线画在哪代表什么」，直接比对「洞的位置」和「落库后它实际排到第几位」：

- `A1` 洞必须出现，且**唯一**（不能有多个占位）
- `A2` 洞必须落在**目标格那一行**
- `A3` 洞必须落在**目标格那一列**（只查纵向会漏掉「跨到隔壁列」）
- `A5` 洞不能越出容器
- `A6` **同一次拖动内连续换位**时，判定基准不能被让位 transform 污染
- 附一条落库验证：它在最终顺序里的位置 = 洞指的位置（**核心判据**）

`allday-assert.mjs` 测的是日视图未定时区（另一种容器结构：
`.allday-zone` 是 wrapper，grid 在内层 `.allday-items`），
判据同上：洞贴最近格 + 洞不越出容器。

> ⚠️ **`drop-assert.mjs` / `drop-scan.mjs` / `drop-scan2.mjs` / `drop-shot.mjs`
> 依赖已废弃的线条模型**（`.ins-line` / `.ins-bar` / `.ins-hl`），
> 跑起来会「采样 0 个落点」地假通过 —— **比没有测试更糟**。
> 要测落点请用 `list-assert.mjs`。

## 演进：参照任务 → 格子模型 → 让位洞

**第一代「参照任务 + before/after」**（已删除）在多列 grid 下有两个硬伤：

1. 参照任务和光标可以差很远。拖左上角任务、光标停在左列，判定却是
   「插到 B 之前」，线画到右列去了 —— 实测偏差 568px。
2. 同一个逻辑位置有多种画法。「插到 B 之后」和「插到 C 之前」结果一样，
   线却画在两个地方，鼠标跨行边界时线会突然跳列。

**第二代「格子模型」**（已删除）：grid 里 N 个格子 ↔ N 个插入位，
第 k 格就是第 k 位。`k % cols == 0` → 行首画横线；否则行中画竖线。

> **不要改回「比较到各条线的远近」** —— 那样光标在格子中心时，
> 它上方的横线比该格的左沿更近，整片区域会被判成同一档，
> 左右拖动又变得没准头。这正是最初的病根。

**第三代「让位洞」（当前）**：拖动时其他任务**实时平滑挪开**，
在光标处留一个洞。落点由「洞在哪」直接表达。

比静态线顺的原因：线只在跨格子边界时跳一下，中间一大段位移完全没有反馈，
眼睛得盯着线猜；让位则是整列依次滑动，落点始终有连续的视觉提示。

### 让位模型的三条铁律

1. **被拖元素留在原位压暗，不参与位移。**
   让它也滑到目标格会与洞叠在同一处 —— 两份占位重叠、原位又空出来，比不做更乱。
   留原地才能同时看出「从哪来」和「到哪去」。

2. **让位必须自己算 transform，不能靠 `insertBefore`。**
   洞是 `position:absolute`（脱离文档流），插在兄弟节点之间**不会挤开任何行** ——
   会出现「DOM 顺序变了、落库也对、画面一动不动」的情况。
   跨行移动更是只有自己算才做得到：相邻两列的格子要一起动，布局流表达不了。

3. **判定基准必须是「未让位的原始坐标」。**
   让位是加在元素上的 transform，`getBoundingClientRect` 读到的是**位移后**的值。
   拿它当基准，第二次判定会整体偏掉一格 —— 实测跨行换位时整列被甩到容器外
   （x 变成 -306 / 1398），第一次却完全正常。
   所以 `dragstart` 时量一次 `rawLayout`，整段拖动过程复用。

4. **让位方向必须整段统一，不能逐格算。**
   正确写法只有一句：夹在「出处」和「目标」之间的格子，一律朝**远离出处**的那一侧挪一格
   （`step = k > selfIdx ? -1 : 1`）。
   曾经写成逐格判断 `i < k ? i+1 : i-1`，符号是反的 —— 单列下相邻两格会挪到同一位置，
   画面上凭空少一条任务，洞也被压在下层看不见（`shift-overlap.mjs` 就是为抓这个写的）。

> 第 4 条的失败症状很有欺骗性：**落库顺序完全正确**、DOM 也动了，
> 只有画面重叠。`list-assert.mjs` 查的是「洞的序号 vs 落库位次」，
> 查不出元素之间有没有撞在一起 —— 所以必须配 `shift-overlap.mjs`。

## 踩过的坑（改测试前先看）

- **合成 DragEvent 走不进应用处理器。** `zone.dispatchEvent(new DragEvent(...))`
  在某些 headless 配置下不会触发应用的 `dragover`，DOM 里一个指示物都没有。
  要截图 / 验真实交互必须用 `Input.dispatchMouseEvent`（见 `shot-shift.mjs`）。
  纯逻辑断言用合成事件就够了，快得多。
- **headless 下真实 HTML5 拖拽建立得很勉强。** 实测 `dragover` 只派发 2 次就
  直接 `dragend`（`drop` 根本不派发），且不同视口表现不一致 —— 这是环境限制，
  不是产品缺陷。验落库链路要手动按顺序派发 `dragstart → dragover → drop`。
- **鼠标静止着松手会被判定为「拖动没生效」** 直接取消（只派 `dragend` 不派 `drop`）。
  松手前必须再补一次微小 `mouseMoved`。
- **必须杀掉 Chrome。** `taskkill /PID <自己>` 杀不到 spawn 出来的 chrome，
  跑完不清会**占住 CDP 端口**，下次运行连到上次的旧页面，
  表现为「DOM 里查不到刚创建的东西」这种假故障。脚本都做了 `/IM chrome.exe` 兜底。
- **CDP 端口要每次换。** 连着跑多个脚本时端口计算可能撞车，
  表现为脚本毫无输出直接 SIGTERM。撞了就 `sed -i 's/const CDP_PORT = .*/&+10/'`。
- **`getBoundingClientRect` 是视口坐标**，别拿它跟 `zone.width` 比长度。
- **`Emulation.setDeviceMetricsOverride` 会触发完整重排**，之后合成事件不再进入
  处理器。截图脚本改用启动参数 `--window-size` 定视口。
- **`getComputedStyle(zone).gridTemplateColumns` 在日视图读不到** ——
  落点容器 `.allday-zone` 不是 grid 本身，grid 在内层 `.allday-items`。
  所以列数一律按几何推断（同一行里最多几个格子），这正是 `inferCols()` 存在的原因。
- **断言阈值别写死。** 用「到最近格子的距离」而不是「小于 N px」，
  否则末行不满时会大量误报（末行右侧的几何空白本就该吸附到上面的行）。
- **洞是 `position:absolute`，`left` 和 `top` 都得算。** 只设 `left` 的话它会停在原处，
  DOM 顺序变了、落库也对，就是看不见。断言时别只查 `dropRef`，也要查洞的实际位置。
- **自动滚屏会重算落点。** `runAutoScroll` 滚完之后会重新调 `showDropGuide()`，
  所以拖到视口边缘时洞会跟着滚。断言时别假设洞的屏幕坐标是固定的。
- **清 transform 时要一并关掉 transition。** 元素带
  `transition: transform .18s`，清掉 transform 后它会**用 180ms 滑回原位**而不是
  立刻归位 —— 紧接着量坐标只会拿到半路值。做法是
  `style.transition='none'` → 清 transform → 强制回流 → 恢复 transition。
  这就是 `snapshotLayout()` 里那段看起来多余的代码的用途。
- **截图/采样要在动画走完之后。** `transition` 是 180ms，同步 `eval` 里读
  `getBoundingClientRect` 拿到的是中间帧，看着像「没让位」。
  正确做法是拆成两次 eval：先派发 `dragover`，`await sleep(260)`，再单独量。
- **别用 `DB.setNav()` 切页去采样。** 它会先按旧状态渲染一帧，
  量到的是上一个页面的容器（待办箱那行曾读成 `habits` 容器就是这么来的）。
  改 `localStorage` 再 `location.reload()`。

## 依赖

`window.__schedDebug` 暴露的动作与状态（只给测试用，线上不需要也能跑）：

| 成员 | 作用 |
|---|---|
| `setNav(nav)` | 切视图 |
| `beginDrag(id, kind)` | 让 dragover 以为正在拖某元素（`kind` 为 `'habit'` 时按习惯处理） |
| `endDrag()` | 结束拖动，复位全部 transform |
| `getDropRef()` | 当前落点参照 `{id, pos}` |
| `getGuides()` | 当前所有指示物的位置 |
| `holeIndex(zoneSel)` | 让位洞排在第几格 |
| `shiftDebug(zoneSel)` | **让位自检**：判定基准是否被污染 |
| `orderOf(id)` | 该任务最终会排到第几位 |

## 文件

| 文件 | 测什么 |
|---|---|
| `list-assert.mjs` | **当前模型**：让位洞 ↔ 落库顺序，覆盖所有可拖列表（待办箱 / 今天 / 逾期各组 / 今天已完成 / 已完成 / 打卡） |
| `allday-assert.mjs` | 日视图未定时区（`.allday-zone` 是 wrapper，grid 在内层 `.allday-items`） |
| `shift-overlap.mjs` | **让位重叠**：`B1` 让位中的行两两不重合、`B2` 洞不被行盖住。遍历 8×8 全部落点 × 4 个视口 |
| `col-check.mjs` | **列数**：8 个视口宽度 × 5 个列表页，断言 `gridTemplateColumns` 轨道数 ≤ 2 |
| `view-smoke.mjs` | 日/周/月 + 待办箱/打卡 冒烟：关键容器在不在、有没有横向溢出、节点数是否非零 |
| `shot-shift.mjs` | 让位动画关键帧截图 + 各格实时坐标，人眼确认滑动是否顺 |
| `drop-assert.mjs` | ⚠️ 依赖废弃的线条模型，会「采样 0 个落点」地假通过 |
| `drop-scan.mjs` | ⚠️ 同上 |
| `drop-scan2.mjs` | ⚠️ 同上 |
| `drop-shot.mjs` | ⚠️ 同上 |

## 列数：电脑版一行最多 2 个

需求是「一行最多放两个，不要放太多」。实现上只保留 `@media (min-width: 1120px)`
那一档 2 列，**1560 / 2000 / 2560 三档（3/4/5 列）已删除**，
容器 `max-width` 从 2400px 收到 1280px —— 容器太宽会让每一行的空白被拉得过长。

`col-check.mjs` 锁住这个约定。注意它读的是**每个 `.mc` 容器自己的**
`gridTemplateColumns`，不是页面的 —— 逾期/已完成按日期分组，每组是独立容器。