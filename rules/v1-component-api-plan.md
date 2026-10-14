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

按**样式组**（不是组件）划分，每组一个 `.module.css`：

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

**注意**：`lists/` `calendar/` 两组若 `views/**` 仍冻结（当前决策），则**暂不迁移**，留在 `views/` 引全局 CSS。第 4 册再动 `views/`。

---

## 2. 扫描器 / 守卫方案

### 5.1 新增 `tests/api-scan.mjs`（零依赖静态扫描）✅ 已落地（c2ccb48）

锁三条（外观类口径 `rounded-[var(` / `bg-[var(` / `text-[var(` / `border-[var(`）：
1. **`domain/` 零外观类**（D1 纯净）—— 硬锁，出现即失败
2. **`views/` 零外观类**（D2 冻结）—— 硬锁，出现即失败
3. **`ui/` 非 kit + `app/` 调用方外观类只减不增**（R4 方向）—— ratchet，baseline 73，涨即失败

> 为什么第 3 条是 ratchet 不是清零：调用方用 Tailwind 工具类 + CSS 变量本就是本项目的
> 正确写法（见 CLAUDE.md 三、界面硬规则），一步清零 = 重写整个 UI 层，不在本册范围。
> 「kit 无 className」也不锁：kit 保留 `className`（布局类，见 2.1），外观走 variant/tone。

### 5.2 现有扫描器保持

- `color-scan.mjs`：颜色/圆角/令牌（已绿）
- `contrast.mjs`：对比度 70+ 对（已绿）
- `browser-smoke.mjs`：400+ 条断言（已绿）

### 5.3 迁移期间的临时豁免

`Dropdown` 当前收了 `className` / `menuClassName`，`Sheet` 收了 `--kb` 兜底。
第一册修 `Dropdown`，`Sheet` 的 `--kb` 是运行时变量（键盘高度），扫描器已豁免，**不动**。

---

## 3. 实施顺序（拆成多步，每步可独立验证）

| 步 | 内容 | 改动文件 | 状态 |
|---|---|---|---|
| S1 | `Btn` 改 cva（`className` 留布局类） | `ui/kit/Btn.tsx` | ✅ 已做（72ff7dd） |
| S2 | `Input`（无 variant 可 cva 化，`className` 留布局类） | `ui/kit/Input.tsx` | ✅ no-op（已合规） |
| S3 | `MiniIconBtn` `danger`/`primary` → `tone` | `ui/kit/IconBtn.tsx` | ✅ 已做（88296f4） |
| S4 | `Dropdown`（选项 `role="option"`，改 `Btn` 毁 A11y，不改） | `ui/kit/Dropdown.tsx` | ✅ no-op（A11y 挡住 + 已合规） |
| S5 | 新增 `api-scan.mjs`，锁 R4（ratchet） | `tests/api-scan.mjs` | ✅ 已做（c2ccb48） |
| S6 | 全局层 `state.css`（R3 状态类白名单） | `styles/state.css` | ✅ 已做（登记 7 个状态类 + 谁有权写；`base.state` 规则**不搬**——纯换宿主零收益 + cascade 顺序风险） |
| S7 | `ui/<组>` 目录迁移 + `.module.css` | 多文件 | ⛔ 不做（见 §4：`.module.css` 与探针硬冲突；目录重组无收益） |

**每步做完必须**：
```bash
cd app && npm run typecheck && npm test && node tests/color-scan.mjs && node tests/api-scan.mjs && npm run build && node tests/browser-smoke.mjs
```

**收尾**（踩坑 40）：`pkill -x chrome` 确认归零；`ss -ltnp` 查残留服务并 `kill`。

---

## 4. verify（2026-10-14）—— S6 落地，S7 有据不修

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

---

## 附录：违规清单（第一册）

| 文件 | 违规 | 修法 | 状态 |
|---|---|---|---|
| `ui/kit/Btn.tsx` | 手写 `Record<Variant>` | 改 cva | ✅ 已修（72ff7dd） |
| `ui/kit/IconBtn.tsx` | `danger` / `primary` 两个布尔 | 合并为 `tone` prop | ✅ 已修（88296f4） |
| `ui/kit/Dropdown.tsx:95-128` | 内部手写 2 处 `<button>` | 改走 `Btn` | ⏸ 不改（选项 `role="option"`，改 `Btn` 毁 A11y） |
| `ui/kit/{Dropdown,IconBtn,Btn}.tsx` | 收 `className` | 留布局类（见 2.1） | ✅ 已定（布局类白名单，Interpretation B） |
| `ui/kit/Sheet.tsx:48` | `pb-[var(--kb,0px)]` | **不动**（运行时变量，扫描器已豁免） | — 保留 |
| `ui/settings/SettingsView.tsx:120` | `rounded-full`（Tailwind 自带） | 改 `rounded-[var(--r-pill)]` | 归第 3 册 N5 |
