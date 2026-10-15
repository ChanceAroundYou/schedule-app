# 重构：组件合并与复用 —— 实施 spec（全量 #1–#7）

> 状态：**待审核**（spec + 针对性测试已产出，实现未开始）
> 依据：`ui/`、`views/` 逐文件审计 + 一轮方案自审（撤回 4 条错误建议）
> 不变量：**外部 import 路径一律不变**（barrel / 就地重构，调用方无感）；
>           `domain/` 保持零 React / DOM / 网络；后端不引任何新依赖。

---

## 0. 测试基础设施现状（决定了 TDD 怎么写）

| 层 | 怎么测 | 命令 |
|----|--------|------|
| `domain/` `data/` `sync/` | `node --test`（Node 内置，零依赖） | `npm test` |
| `ui/` `views/` | **无单测**，靠浏览器探针 `tests/browser-smoke.mjs` | `node tests/browser-smoke.mjs` |
| 颜色 / 圆角 / 令牌 | `tests/color-scan.mjs`（零依赖静态扫描） | `node tests/color-scan.mjs` |

**推论**：
- 能写**纯函数单测**的（#1）→ 走 `domain/`，进 `npm test`，可 TDD。
- 依赖 DOM 的（#2 #3 #6 #7）→ 只能靠**探针回归**（现状全绿 → 改完仍全绿），不新造 hook 单测（项目没 jsdom，不加依赖）。
- 颜色 / 圆角（#4 #5）→ 扩 `color-scan.mjs` 的断言，可 TDD。

---

## 1. `useAnchoredPosition` —— 浮层定位算式去重

### 现状（同一段算式，逐字 4 份）

| 文件:行 | 代码 |
|---------|------|
| `ui/DatePicker.tsx:31-41` | `useLayoutEffect` 量 anchor + panel，翻上 / 收左 |
| `ui/TimePicker.tsx:20-30` | 同上 |
| `ui/WhenPop.tsx:96-107` | 同上 |
| `ui/drawer/useDrawer.ts:84-94` | 同上（「重复」浮层） |

四份逐字相同的核心（只有依赖数组不同）：

```ts
let top = r.bottom + 6;
let left = r.left;
if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
```

### 目标

拆成 **纯函数 `placePanel`（放 `domain/layout.ts`，可单测）+ hook `useAnchoredPosition`（放 `ui/hooks/` 薄封装）**。

### 改动

**1a. `src/domain/layout.ts` 末尾追加**（纯函数，无 DOM；与文件内 `minToPct` 同类：UI 几何）：

```ts
/** 浮层锚定定位：贴着 anchor 下沿弹出；下方放不下翻到上方，右侧超出往左收。 */
export interface PlacePanelInput {
  anchor: { top: number; bottom: number; left: number };
  size: { w: number; h: number };
  viewport: { w: number; h: number };
  /** 与 anchor 的间距，默认 6 */
  gap?: number;
  /** 与视口边缘的最小留白，默认 8 */
  pad?: number;
}
export function placePanel(i: PlacePanelInput): { top: number; left: number } {
  const { anchor, size, viewport, gap = 6, pad = 8 } = i;
  let top = anchor.bottom + gap;
  let left = anchor.left;
  if (top + size.h > viewport.h - pad) top = Math.max(pad, anchor.top - size.h - gap);
  if (left + size.w > viewport.w - pad) left = Math.max(pad, viewport.w - size.w - pad);
  return { top, left };
}
```

**1b. 新建 `src/ui/hooks/anchored.ts`**：

```ts
import { useLayoutEffect, useState, type RefObject } from 'react';
import { placePanel } from '../../domain/layout.ts';

/** 量 anchor/panel 并算出 fixed 定位。返回 null = 还没量到（先藏起来，别在左上角闪一帧）。 */
export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  deps: readonly unknown[] = [],
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) { setPos(null); return; }
    const r = anchor.current.getBoundingClientRect();
    setPos(placePanel({
      anchor: { top: r.top, bottom: r.bottom, left: r.left },
      size: { w: panel.current.offsetWidth, h: panel.current.offsetHeight },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方给（层高/月份变了要重量）
  }, [open, anchor, panel, ...deps]);
  return pos;
}
```

**1c. 四处替换**：
- `DatePicker.tsx`：删 `pos` state + `useLayoutEffect`（31-41），改 `const pos = useAnchoredPosition(anchor, panel, open);`
- `TimePicker.tsx`：同上（删 18、20-30 的 pos/effect）
- `WhenPop.tsx`：`const pos = useAnchoredPosition(anchor, box, open, [layer, month]);`
- `useDrawer.ts`：`const repPos = useAnchoredPosition(repAnchor, repPanel, repOpen, [task?.repeat.unit, task?.repeat.n, task?.repeat.end?.type]);`

**1d. `ui/hooks.ts` barrel 补一行** `export * from './hooks/anchored.ts';`（该 barrel 已存在，见 `ui/hooks/` 目录）。

### 验证
- T1（新增单测，见 §8）：`placePanel` 4 个用例。
- 探针回归：抽屉日期 / 时间 / 重复浮层、快速添加 WhenPop、JumpPop 位置不变。

---

## 2. `useModalFocus` —— 模态浮层焦点进出

### 现状（同一段 effect，逐字 3 份）

| 文件:行 | 代码 |
|---------|------|
| `ui/kit/Sheet.tsx:44-55` | 焦点送进面板 + 关时还回 `prevFocus` |
| `ui/shell/Tabbar.tsx:77-88` | 同上（MoreSheet） |
| `ui/drawer/useDrawer.ts:131-142` | 同上 |

三份逐字相同的核心：

```ts
if (!panel.current?.contains(document.activeElement)) {
  prevFocus.current = document.activeElement as HTMLElement | null;
}
panel.current?.focus({ preventScroll: true });
return () => {
  const el = prevFocus.current;
  prevFocus.current = null;
  if (el && el.isConnected) el.focus({ preventScroll: true });
};
```

### 目标

抽 `useModalFocus(panel, open)`，三处替换。

### 改动

**2a. 新建 `src/ui/hooks/modalFocus.ts`**：

```ts
import { useEffect, useRef, type RefObject } from 'react';

/**
 * 模态浮层的焦点进出：开时把焦点送进**面板本身**（不是第一个控件 ——
 * 送进输入框会当场弹手机软键盘），关时还回原来那个元素。
 * 记录前先看焦点在不在面板里：从一条任务切到另一条时面板不卸载，
 * activeElement 是面板自己，记下来等于把「还回哪」擦掉。
 */
export function useModalFocus(panel: RefObject<HTMLElement | null>, open: boolean): void {
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    if (!panel.current?.contains(document.activeElement)) {
      prevFocus.current = document.activeElement as HTMLElement | null;
    }
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [panel, open]);
}
```

**2b. 三处替换**（各自删掉本地 `prevFocus` + effect，保留各自的 `useFocusTrap`）：
- `Sheet.tsx`：删 30 的 `prevFocus`、44-55 的 effect → `useModalFocus(panel, open);`
- `Tabbar.tsx`（MoreSheet）：删 71 的 `prevFocus`、77-88 的 effect → `useModalFocus(panel, open);`
- `useDrawer.ts`：删 46 的 `prevFocus`、131-142 的 effect → `useModalFocus(panel, !!task);`

**2c. `ui/hooks.ts` barrel 补** `export * from './hooks/modalFocus.ts';`

### 关键约束（**不要**顺手统一 Esc）
三个模态浮层的 Esc 处理**故意不同**，别合：
- `Drawer`（`useDrawer.ts:77-82`）自己挂，`onClose`；
- `MoreSheet` **交给上层**（`Workbench.tsx:64-68`：Esc 要按 more→search→jump→drawer 排顺序），自身**不挂**；
- `Sheet`（`Sheet.tsx:35-40`）自己挂，带 `dismissable` 开关。

### 验证
- 探针回归：打开 / 关闭抽屉、更多抽屉、各类 Sheet 时，焦点落点与还回不变；Tab 不逃逸。

---

## 3. popover 的「点外面关 + Esc」收敛

### 现状（逐字 2 份）

`ui/DatePicker.tsx:44-64` 与 `ui/TimePicker.tsx:32-50` 逐字相同：`mousedown` capture 判 `panel/anchor.contains` + Esc `stopImmediatePropagation`。

### 目标

复用已有 `useOutsideClose`（`ui/hooks/overlay.ts:15`），Esc 那段抽 `useEscape`。

### 改动

**3a. `ui/hooks/overlay.ts` 追加**：

```ts
/** Esc 关闭浮层，并**截断**事件 —— 否则 App 那层的 Esc 会跟着再关一次抽屉。 */
export function useEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      close();
    };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, [open, close]);
}
```

**3b. `DatePicker.tsx` / `TimePicker.tsx` 替换**：
```ts
useOutsideClose(panel, open, () => setOpen(false));
useEscape(open, () => setOpen(false));
```
> 注意 `useOutsideClose` 的签名是 `(ref, open, close, trigger?)` —— DatePicker/TimePicker 的开合按钮就是 anchor，**必须传 trigger**（否则 `mousedown` 先关、`click` 又翻回来，真机上「点按钮关不掉」，见 `overlay.ts:9-13`）。
> 但那两个组件的 `anchor` 是**同一个**按钮，且面板定位也认它 —— `useOutsideClose(panel, open, close, anchor)` 即可。
> 手写版判的是 `panel.contains || anchor.contains`，与 `useOutsideClose` 的「本面板 / trigger」等价。

### 验证
- 探针：日期 / 时间按钮点开 → 点外面 / Esc → 关闭；点按钮本身能关掉。

---

## 4. `lists.css:344` 的白字（消 color-scan 现有 FAIL）

### 现状
`styles/lists.css:344`：`.tl-dur-tag { … background: rgb(0 0 0 / .55); color: #fff; }`
`color-scan.mjs:83` 规则「主色上的白字」`/color:\s*#fff\b/` 抓到它 → **当前唯一 FAIL**。

### 定性
这是扫描器的**误报**：`.tl-dur-tag` 的底是纯黑半透明，不是主色底，白字永远对。但规则按值一刀切。

### 改动
`lists.css:344`：`color: #fff` → `color: var(--toast-fg)`（值同为 `#fff`，语义同族：深色小条上的前景），并补一行注释说明它是「深色标签，非主色底」。

> 不修 `color-scan.mjs`（改测试放宽）—— 收紧容易、放宽会漏检，方向反了。

### 验证
- T2（扩 `color-scan.mjs`，见 §8）。
- 目标：`node tests/color-scan.mjs` **0 条不达标**。

---

## 5. `SettingsView.tsx:120` 的写死圆角

### 现状
`ui/settings/SettingsView.tsx:120`：`className="inline-block h-3 w-3 shrink-0 rounded-full"` —— Tailwind 自带 `rounded-full`，写死像素，切 flat / notion 原地不动。**全仓唯一一处**（AGENTS.md 三、令牌三条禁的就是它）。

### 改动
`rounded-full` → `rounded-[var(--r-pill)]`（`--r-pill: 999px` 已在 `tokens.css:58`）。

### 验证
- T3（扩 `color-scan.mjs` 新增 `.tsx` 圆角扫描，见 §8），当前应抓出这 1 处。
- 目标：0 处。

---

## 6. 图标按钮收敛 —— **逐处判定，多数保持**

### 判定原则
只有「**无文字 + 无自带样式类 + 布局允许**」的纯图标按钮才值得换 `IconBtn` / `MiniIconBtn`。
有文字、或有特殊布局、或自带语义类名（`.check-btn` / `.jp-nav` / `.tab` …）的，**保持现状**。

### 逐处判定表

| 文件:行 | 现状 | 判定 | 理由 |
|---------|------|------|------|
| `ui/MiniCalendar.tsx:37,43` | `<button class="jp-nav">` 上/下月 | **保持** | 自带 `.jp-nav` 样式 + `aria-label` + `title`；换 `MiniIconBtn` 要连样式类一起端走，无收益 |
| `ui/shell/Topbar.tsx:47` | `.clear-search` 清空搜索 | **保持** | 绝对定位在 Input 右侧，改 `MiniIconBtn` 破坏布局 |
| `ui/shell/Topbar.tsx:221` | `.search-toggle` | **保持** | 注释明确「故意不用 IconBtn」（图标归框，见 `Topbar.tsx:218-220`） |
| `ui/drawer/RepeatPop.tsx:100,104` | `.dp-nav-btn` 月份切换 | **保持** | 自带类名 + 与 DatePicker 同源 |
| `ui/TimePicker.tsx:54` / `ui/DatePicker.tsx:70` | `.tp-btn` / `.dp-btn` | **保持** | **有文字**（label 文本） |
| `ui/Clock.tsx:56,69,73` | 表盘内按钮 | **保持** | 表盘专有布局 |
| `ui/kit/Toast.tsx:53` | toast 动作按钮 | **保持** | 反色条专有样式（见 §附录-A） |
| `ui/drawer/ConflictBox.tsx:50` | 「知道了」 | **保持** | **有文字** |
| `ui/aipanel/Bubble.tsx:84` | 「打开设置」 | **保持** | **有文字** |
| `ui/shell/JumpPop.tsx:59` | 「跳转」 | **保持** | **有文字** |
| `ui/aipanel/AiPanel.tsx:227` | 会话列表项 | **保持** | **列表项**，语义类 `ai-session-item` |
| `ui/shell/Tabbar.tsx:31,46,110,132` | `.tab` / `.ms-item` | **保持** | **导航 / 列表项** |

### 结论
**无一处满足「值得换」的条件 → #6 净收益 ≈ 0，本项取消。**
（原方案估的「约 9 处」经逐处核对不成立 —— 那些要么有文字、要么自带样式类、要么是导航/列表项，换 kit 只会带上无关的 variant/size 开销。）

> 若用户仍要求「统一到 kit」，则需先给 `IconBtn` / `MiniIconBtn` 加 `size` + `className` 透传能让位的样式，属**扩大 API**，不在本次范围。

---

## 7. 大文件拆分（barrel 模式，外部 import 路径不变）

拆出的子组件放**同目录**，主文件 `import` 它们、自身导出不变。

### 7.1 `ui/settings/CalsTab.tsx`（368）→ 拆出 `CalItem`
- 新建 `ui/settings/CalItem.tsx`：搬 `CalsTab.tsx:154-366` 的 `CalItem`（含它专用的 imports：`Crown/Eye/…`、`InlineRename`、`MiniIconBtn`、`useConfirm`、`api`、`cx`）。
- `CalsTab.tsx` 保留 `DayWindowCard`(43-67) + `CalsTab`(93-151)，`import { CalItem } from './CalItem.tsx';`。
- 导出不变：`export { DayWindowCard, CalsTab };`

### 7.2 `ui/aipanel/AiPanel.tsx`（360）→ 拆出 `AiBar` + `AiCompose`
- 新建 `ui/aipanel/AiBar.tsx`：搬 213-264 的顶栏（含会话列表 dropdown）。
- 新建 `ui/aipanel/AiCompose.tsx`：搬 327-348 的输入区。
- `AiPanel.tsx` 保留状态 + send/confirm 逻辑 + 气泡列表，import 两个子组件。导出不变。

### 7.3 `ui/shell/QuickAdd.tsx`（324）→ 拆出 `FastSide`
- 新建 `ui/shell/FastSide.tsx`：搬 250-279 的「时钟 + 保存」竖排按钮组。
- `QuickAdd.tsx` 保留状态机（closing / expanded / outside-close 三级）+ 主体。导出不变。
- > FAB（292-310）**留主文件** —— 它和 `closeBar/openBar` 状态强耦合，拆出去要透传 3 个回调，不值。

### 7.4 `ui/shell/Topbar.tsx`（251）→ 拆出 `SearchInput`
- 新建 `ui/shell/SearchInput.tsx`：搬 32-53 的 `SearchInput` + 17-22 的 `useSearchValue`。
- `Topbar.tsx` 保留 `CalSubheader` + `Topbar`，import。注意 `CalSubheader` 已被外部从 `Shell.tsx` 导出 → 导出不变。

### 7.5 `ui/settings/SettingsView.tsx`（234）→ 拆出各 tab 内容
- 新建 `ui/settings/AppearanceTab.tsx`：搬 102-149（NavCard + 外观卡 + DayWindowCard）。
- 新建 `ui/settings/SecurityTab.tsx`：搬 151-212（账号卡 + 同步备份卡）。
- `SettingsView.tsx` 保留 tab 外壳 + `about`（很短）。导出不变。
- > `about` 段（216-229）很短，留主文件。

### 7.6 `views/calendar/DayView.tsx`（249）→ **不拆**
`TaskCard` + `TimedCard` 已拆为文件内组件，剩下的是单一 `DayView` 主体，249 行主要在注释。**保持。**

### 验证
- 探针全量回归（清单页、日/周/月视图、设置 4 个 tab、AI 面板、快速添加）。

---

## 8. 针对性测试（TDD，先红）

### T1 — `placePanel` 单测（#1）→ 加进 `src/domain/domain.test.ts`
RED 理由：`placePanel` 尚不存在 → import 得到 `undefined` → 调用抛错。

```ts
import { placePanel } from './layout.ts';   // 追加到既有 import

test('placePanel：下方放得下就贴下沿，左对齐 anchor', () => {
  assert.deepEqual(
    placePanel({ anchor: { top: 100, bottom: 130, left: 40 },
                 size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 } }),
    { top: 136, left: 40 });
});

test('placePanel：下方放不下 → 翻到 anchor 上方', () => {
  assert.deepEqual(
    placePanel({ anchor: { top: 700, bottom: 730, left: 40 },
                 size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 } }),
    { top: 544, left: 40 });   // 700-150-6
});

test('placePanel：右侧超出 → 靠右贴边（留 8px）', () => {
  assert.deepEqual(
    placePanel({ anchor: { top: 100, bottom: 130, left: 1100 },
                 size: { w: 200, h: 150 }, viewport: { w: 1200, h: 800 } }),
    { top: 136, left: 992 });   // 1200-200-8
});

test('placePanel：上下都放不下 → 上方钳到 8px', () => {
  assert.deepEqual(
    placePanel({ anchor: { top: 20, bottom: 780, left: 40 },
                 size: { w: 200, h: 700 }, viewport: { w: 1200, h: 800 } }),
    { top: 8, left: 40 });
});
```

### T2/T3 — 扩 `tests/color-scan.mjs` 断言
- **T3（#5）**：新增「`.tsx` 里的 Tailwind 自带圆角」扫描（仿现有 `<select>` 那段逐文件扫）：
  正则 `/\brounded(-(sm|md|lg|xl|2xl|3xl|full|none))?\b/`，**豁免** `rounded-[var(`。
  → 当前应抓出 `src/ui/settings/SettingsView.tsx:120` **1 处** → FAIL（RED）。
- **T2（#4）**：无需新增 —— 现有「主色上的白字」规则已经 FAIL 1 处（正是 `lists.css:344`），即 RED 已存在。

### 回归基线（#2 #3 #6 #7）
改动前先跑一遍存档：
```bash
cd app && npm run build && node tests/browser-smoke.mjs   # 记下 420/420 之类的基线
```
改后必须**逐条对齐**（新增/消失的断言要能解释）。

---

## 9. 验证命令（每步做完）

```bash
cd app
npm run typecheck                        # 类型
npm test                                 # domain/data/sync 单测（含 T1）
node tests/color-scan.mjs                # 颜色/圆角（含 T2/T3），目标 0 条不达标
npm run build                            # tsc -b && vite build
node tests/browser-smoke.mjs             # UI 探针全量回归
```

**收尾**（踩坑 40）：`pkill -x chrome` 确认归零；`ss -ltnp` 查残留服务并 `kill`。

---

## 附录

### A. 附带回溯发现（**不在本次 #1–#7 范围**，建议单独记一笔）
`styles/overlays.css:26-29`：`.check-circle` 底是 `background: var(--primary)`，而白色勾 `border: solid #fff` **写死**。暗色档 `--primary: #6fc0a0`（浅绿）压白勾，对比度约 2:1 —— 应为 `var(--on-primary)`。
`color-scan` 抓不到：规则只匹配 `color:`，漏了 `border:`。**这是真 bug，但不属组件拆分**，待用户另行拍板。

### B. 撤回的原方案条目（勿实施）
| 原建议 | 撤回理由 |
|--------|----------|
| TimePicker 补 `aria-modal` | 它是 popover（无遮罩、点外面关），标模态是假承诺 |
| Toast `text-white` / `#8fb0ff` 改令牌 | 有对比度注释保护；且不在 color-scan 范围（它扫 `color:` 与 CSS，非 Tailwind 类） |
| AiHistory checkbox 换 `CheckBtn` | 语义不同（筛选开关 vs 任务勾选圈），原生 checkbox + label 正确 |
| 遮罩 `.mask` / `.sheet-mask` / `bg-black/40` 统一 | 三者色相/透明度不同（`.34` / `.4` / 纯黑 `.4`），统一 = 改视觉 |
