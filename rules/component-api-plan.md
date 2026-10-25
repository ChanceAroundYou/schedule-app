# 第 1 册 · 组件 API 与样式归属 — 实施计划

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`v1-component-api-rules.md`](v1-component-api-rules.md)——本文件只放「按什么顺序修、修哪些」。
> 改动若触及第 5/8 册（数据流、无障碍），回对应册的 plan 登记。
> 不变量：**外部 import 路径一律不变**（barrel / 就地重构，调用方无感）。

---

## 0. 怎么读本文件

本册规则在 `v1-component-api-rules.md`，本文件只放实施侧：**在哪落地、按什么顺序、怎么验**。
段号在本文件内从 1 起算（原来 spec 的 §4–§6 + 附录），不回指 rules 的段号。

---
## 1. `ui/<组>` 目录规划

> **2026-10-14 用户裁决**：按本节五组落地（不采用「按现有 CSS 文件原样成组」的轻量方案）。
> 一次全做完，内部拆子步；每子步全量 gate 绿才进下一步。落地时**类名跟随它实际所在的
> CSS 文件搬迁**，组件文件按主样式归属移动；下表「实际映射」列是本节的权威口径。

```
ui/
  overlays/          ← 浮层通用（dp-*/field/repeat-*）
    overlays.module.css
    DatePicker.tsx
    TimePicker.tsx
    WhenPop.tsx
    RepeatPop.tsx
  shell/             ← 外壳（jp-*/search-*/nav-*）
    shell.module.css
    Topbar.tsx
    Sidebar.tsx
    Tabbar.tsx
    JumpPop.tsx
    QuickAdd.tsx
    SearchInput.tsx
  lists/             ← 列表（habit-*/task-*/ci-*）
    lists.module.css
    （列表组件，若 views/ 仍冻结则暂留 views/）
  calendar/          ← 日历（week-*/month-*/task-*）
    calendar.module.css
    （若 views/ 仍冻结则暂留 views/）
  kit/               ← 基础组件（Btn/Input/IconBtn/...）
    kit.module.css   ← 或每个组件一个 .module.css，视耦合度
    Btn.tsx
    Input.tsx
    ...
```

**实际映射**（2026-10-14 按磁盘核实；「宿主」= 用了该前缀的 .tsx）：

| 组 | `.module.css` | 接收的类前缀 | 宿主（.tsx） | 类名现居 |
|---|---|---|---|---|
| `overlays/` | `overlays.module.css` | `.dp-` `.tp-` `.drawer*` `.mask` `.toast` `.rep-` `.repeat-pop` | DatePicker · TimePicker · Drawer · RepeatPop · MiniCalendar(共用 `.dp-`) | `overlays.css` |
| `shell/` | `shell.module.css` | `.topbar*` `.brand*` `.nav*` `.sidebar*` `.search*` `.cal-menu*` `.jump*` `.view-switch` `.view-title` `.more-sheet` `.tab` `.tabbar` | Topbar · Sidebar · Tabbar · JumpPop · SearchInput · Calendars | `shell.css` + `responsive.css` |
| `quick-add/` | `quick-add.module.css` | `.fast-*` `.fc-*` `.when-pop` `.wp-*` `.cp-*` `.repeat-panel` `.rp-*` | QuickAdd · FastSide · WhenPop · Clock · RepeatPop | `quick-add.css` |
| `kit/` | `kit.module.css` | `.btn` `.input` `.icon-btn` `.field-*` `.check-circle` `.check-wrap` | kit 全体 · Drawer · AiSettings | `overlays.css` 部分 |
| `lists/` | `lists.module.css` | `.task-row` `.habit-*` `.ci-*` `.td-*` `.heat-*` `.check-btn` `.list-*` `.today-done` `.trash-*` `.od-*` `.row-*` `.group-*` `.drag-overlay` `.drop-hole` | **views/**（冻结） | `lists.css` |
| `calendar/` | `calendar.module.css` | `.week-*` `.month-*` `.wk-*` `.cell-*` `.ev-*` `.tl-*` `.task-el` `.task-pill` `.allday-*` `.zone-*` `.empty*` | **views/**（冻结） | `calendar.css` |

**搬迁规则**（R2「一个类名一个宿主」的落地口径）：

1. **类名跟随它实际所在的 CSS 文件**——`.cp-*` 物理在 `quick-add.css` 就算 `quick-add/` 组，
   尽管 plan 上面的目录树把它画在 `overlays/` 段（纸面理想，对不上代码）。**本表为准**。
2. **共用前缀不拆**：`.dp-` 被 DatePicker + MiniCalendar 用、`.jp-` 被 MiniCalendar + DayGrid + JumpPop 用
   ——两个组件都进同一组、共用一份 module。这正是 R1「绑组不绑组件」的原意。
3. **组件文件按主样式归属移动一次**（`RepeatPop` 从 `ui/drawer/` → `ui/quick-add/`、
   `Clock` 从 `ui/` → `ui/quick-add/`、`DatePicker`/`TimePicker`/`WhenPop`/`MiniCalendar` → `ui/overlays/`）；
   `import` 路径归 barrel（第 4 册）管，本册只保证 `ui/kit.tsx` `ui/hooks.ts` 两个入口的导出名不变。
4. **`views/Projects.tsx` 的 74 处内联外观类不迁**：`views/` 冻结（第 5 册 D2），本册只登记进附录。

**注意**：`lists/` `calendar/` 两组若 `views/**` 仍冻结（当前决策），则**暂不迁移**，留在 `views/` 引全局 CSS。第 4 册再动 `views/`。

---

## 2. 扫描器 / 守卫方案

### 5.1 新增 `tests/api-scan.mjs`（零依赖静态扫描）✅ 已落地（c2ccb48）

锁三条（外观类口径 `rounded-[var(` / `bg-[var(` / `text-[var(` / `border-[var(`）：
1. **`domain/` 零外观类**（D1 纯净）—— 硬锁，出现即失败
2. **`views/` 零外观类**（D2 冻结）—— 硬锁，出现即失败
3. **`ui/` 非 kit + `app/` 调用方外观类只减不增**（R4 方向）—— ratchet，baseline 73，涨即失败

> 为什么第 3 条是 ratchet 不是清零：调用方用 Tailwind 工具类 + CSS 变量本就是本项目的
> 正确写法（见 `AGENTS.md` 三、界面硬规则），一步清零 = 重写整个 UI 层，不在本册范围。
> 「kit 无 className」也不锁：kit 保留 `className`（布局类，见 2.1），外观走 variant/tone。

### 5.2 现有扫描器保持

- `color-scan.mjs`：颜色/圆角/令牌（已绿）
- `contrast.mjs`：对比度 70+ 对（已绿）
- `browser-smoke.mjs`：400+ 条断言（已绿）

### 5.3 迁移期间的临时豁免

`Dropdown` 当前收了 `className` / `menuClassName`（实测全是布局/定位类，见 2.1）。
第一册修 `Dropdown`。

---

## 3. 实施顺序（拆成多步，每步可独立验证）

| 步 | 内容 | 改动文件 | 状态 |
|---|---|---|---|
| S1 | `Btn` 改 cva（`className` 留布局类） | `ui/kit/Btn.tsx` | ✅ 已做（72ff7dd） |
| S2 | `Input`（无 variant 可 cva 化，`className` 留布局类） | `ui/kit/Input.tsx` | ✅ no-op（已合规） |
| S3 | `MiniIconBtn` `danger`/`primary` → `tone` | `ui/kit/IconBtn.tsx` | ✅ 已做（88296f4） |
| S4 | `Dropdown`（触发器/选项是 ARIA listbox 部件，非动作按钮，不适用 Btn） | `ui/kit/Dropdown.tsx` | ✅ 已定（listbox 部件保持手写 + 完整 ARIA，收在 `DropdownMenu`） |
| S5 | 新增 `api-scan.mjs`，锁 R4（ratchet） | `tests/api-scan.mjs` | ✅ 已做（c2ccb48） |
| S6 | 全局层 `state.css`（R3 状态类白名单） | `styles/state.css` | ✅ 已做（登记 7 个状态类 + 谁有权写；`base.state` 规则**不搬**——纯换宿主零收益 + cascade 顺序风险） |
| S7 | `ui/<组>` 目录迁移 + `.module.css` | 多文件 | ✅ 已做（fbaaacc A–D + f3ae050 E–F；module 方案退回普通 `.css`，见 §4 风险兜底） |

**每步做完必须**：
```bash
cd app && npm run typecheck && npm test && node tests/color-scan.mjs && node tests/api-scan.mjs && npm run build && node tests/browser-smoke.mjs
```

**收尾**（踩坑 40）：`pkill -x chrome` 确认归零；`ss -ltnp` 查残留服务并 `kill`。

---

## 4. verify（2026-10-14）—— S6 落地，S7 有据不修【S7 部分已推翻，见 §5】

**S6 落地**：`styles/state.css` 建成 R3 状态类**白名单清单**（登记 7 个状态类 + 谁有权写：
`.done`/`.today`/`.busy` 数据驱动、`.open`/`.sheet-open` JS 状态、`.dragging`/`.drag-land` dnd-kit），
在 `tailwind.css` 里 `overlays` 之后、`responsive` 之前 import。`base.state` 的**样式规则不搬**：
它们散在 7 个分组文件、且 cascade 顺序是 `tokens→shell→calendar→lists→quick-add→overlays→responsive`，
搬进一处是纯换宿主、零收益，还会打乱等特异度规则的先后 —— R3 要的是「集中列一份清单」，清单已列。

**S7 有据不修**（两条硬理由，非偷懒）：

1. **`.module.css` 与探针硬冲突。** `browser-smoke.mjs` 400+ 断言里几百处按**全局类名**选元素
   （`.when-pop`×22 · `.fast-fab`×21 · `.fast-add.open`×21 · `.drawer.open`×12 · `.task-el` …）。
   CSS Module 把类名改写成哈希（`.when-pop`→`.whenPop_1a2b`），这些断言**当场全红**；要保住
   「探针不回归」就得把探针也重写一遍 —— 那已不是「纯搬文件」，是重写测试层。
2. **目录重组无收益。** `ui/` 现状按 **feature** 分组（`drawer/` 把 Drawer+DrawerFields+RepeatPop+
   ConflictBox 放一起、`shell/` `kit/` 已就位），比 plan 设想的「按样式组」更内聚；把 RepeatPop 从
   `drawer/` 挪去 `overlays/` 是拆散内聚组件。plan 的 `overlays/shell/lists/calendar/kit` 是纸面理想，
   对不上真实代码。

> 结论：v1 判据 1（外观归属被 api-scan 锁）+ 判据 2（kit 走 variant/tone，S1/S3）已绿；
> S6 补上 R3 清单；S7 的两半各有硬约束挡着，**不修是对的**，不是没做完。

> **【2026-10-14 推翻 —— 旧结论保留，不删】** 上述两条经复核**都不成立**：
>
> 1. **「与探针硬冲突」前提就错了。** R6（rules §1）已把**业务类**（组件根，`.when-pop`
>    `.fast-fab` `.drawer`）与**样式类**（内部子元素，`.dp-cell` `.wp-row`）分开：探针选的是
>    **业务类**，CSS Modules 只哈希**样式类**。业务根留全局 → 400+ 断言的选择器**一个字不改**。
>    原判断把「所有类都进 module」当成了唯一做法。
> 2. **「目录重组无收益」实测不成立。** R2「一个类名一个宿主」**现在就是破的**：
>    `.rp-row` 两宿主（`quick-add.css:303` + `overlays.css:260`）、`.check-*` 三宿主
>    （`.check-btn`@lists / `.check-circle` / `.check-wrap`@overlays）、跨组件选择器
>    `.dp-pop .jp-cell`×4、`.repeat-pop input.rp-n` —— 这些**正是「零散样式」的形态**。
>
> 更正：S7 的前置条件是「业务类已挂到组件根」，这正是 §5 的子步 A。

---

## 5. S7 子目标树（2026-10-14 立项）

**大目标**：`ui/**` 的零散样式打包成 6 个样式组（`overlays/ shell/ quick-add/ kit/ lists/ calendar/`），
每组一份 `.module.css`；业务根类留全局当测试把手；全量 gate 绿。

**不变量**（每个子步都查）：
- `ui/kit.tsx`、`ui/hooks.ts` 两个 barrel 的**导出名不变**（调用方无感）
- 探针断言**不改选择器**（只认业务类）；红了先怀疑业务类没挂上
- `styles/` 只留 `tokens.css` `responsive.css` `state.css` + `lists.css` `calendar.css`（views 冻结）
- `api-scan.mjs` 的调用方外观类 ratchet 只减不增（74 → 0）

| 子步 | 干什么 | 判据 | 状态 |
|---|---|---|---|
| **A** | **业务根类补齐**：逐组件根挂稳定语义类（`.when-pop` `.fast-add` `.drawer` 已有；`.tp` `.dp` `.cp-face` `.jp-grid` `.field` 等规范化），登记进 `state.css` 同级清单 | 每个 `ui/**` 组件根有业务类；探针选择器全绿 | ✅ |
| **B** | **建 6 个样式组**：类名按 §1 实际映射表搬进 `<组>.css`（module 方案退回普通 CSS，见 §4 风险兜底）；`styles/*.css` 对应段删除 | 6 个组 css 存在；`styles/` 只剩 5 内容文件 | ✅ |
| **C** | **组件改引**：内部子元素用全局类裸串（module 退回后 `s.xxx` 变裸串）；根仍为业务类裸串 | typecheck 绿；`npm run build` 后页面无未加样式 | ✅ |
| **D** | **清调用方外观类**：`ui/` 非 kit 的 74 处内联 `*-[var(--*)]` 归到语义类（`tailwind.css` 末「S7 子步 D」段） | `api-scan` 调用方 74 → 0 | ✅ |
| **E** | **目录落位**：组件文件按 §1 规则 3 移动；import 路径改；删空目录 | 经 import 的引用不变；探针绿 | ✅ |
| **F** | **锁死**：`api-scan.mjs` 加两条 —— ① `styles/` 只留全局 6 文件 ② `ui/**` 零 `.css` import（module 方案退回后按实际架构重述） | 扫描器绿；故意犯规能红（TDD 先红后绿） | ✅ |

**顺序**：A 必须最先（没有业务根类，B/C 一改就断探针 —— 那才是「硬冲突」的真身）。
B/C **按组推进**（`overlays → quick-add → shell → kit`），每组改完立刻跑一次全量 gate，红就退回该组。

---

## 附录：违规清单（第一册）

| 文件 | 违规 | 修法 | 状态 |
|---|---|---|---|
| `ui/kit/Btn.tsx` | 手写 `Record<Variant>` | 改 cva | ✅ 已修（72ff7dd） |
| `ui/kit/IconBtn.tsx` | `danger` / `primary` 两个布尔 | 合并为 `tone` prop | ✅ 已修（88296f4） |
| `ui/kit/Dropdown.tsx` | 触发器/选项手写 `<button>` | ARIA listbox 部件，非动作按钮 | ✅ 已定（`role="option"` 不适用 Btn，保持手写 + 完整 ARIA，收在 `DropdownMenu`） |
| `ui/kit/{Dropdown,IconBtn,Btn}.tsx` | 收 `className` | 留布局类（见 2.1） | ✅ 已定（布局类白名单，Interpretation B） |
| `ui/settings/SettingsView.tsx` | `rounded-full`（Tailwind 自带） | 改 `rounded-[var(--r-pill)]` | ✅ 已修（现为 `rounded-[var(--r-lg)]`/`rounded-[var(--r-sm)]`，归第 3 册 N5 一并清） |
