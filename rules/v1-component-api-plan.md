# 第 1 册 · 组件 API 与样式归属 — 实施计划

> 状态：**待审核**（实施计划，分期完成）
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

### 5.1 新增 `tests/api-scan.mjs`（零依赖静态扫描）

锁三件事：
1. **`ui/` `app/` 调用方不写 Tailwind 外观类**：正则 `/rounded-\[var\(|bg-\[var\(|text-\[var\(|border-\[var\(/` 扫 `.tsx`，豁免 `ui/kit/**` 内部
2. **kit 组件无 `className` 透传**：扫 `ui/kit/**.tsx` 的 props 定义，有 `className?: string` 即报错
3. **`views/` 语义类不动**：扫 `views/**/*.tsx` 的 `className`，出现 Tailwind 外观类即报错（语义类白名单豁免）

### 5.2 现有扫描器保持

- `color-scan.mjs`：颜色/圆角/令牌（已绿）
- `contrast.mjs`：对比度 70+ 对（已绿）
- `browser-smoke.mjs`：400+ 条断言（已绿）

### 5.3 迁移期间的临时豁免

`Dropdown` 当前收了 `className` / `menuClassName`，`Sheet` 收了 `--kb` 兜底。
第一册修 `Dropdown`，`Sheet` 的 `--kb` 是运行时变量（键盘高度），扫描器已豁免，**不动**。

---

## 3. 实施顺序（拆成多步，每步可独立验证）

| 步 | 内容 | 改动文件 | 验证 |
|---|---|---|---|
| S1 | `Btn` 改 cva，删 `className` | `ui/kit/Btn.tsx` | typecheck + 探针 |
| S2 | `Input` 删 `className` | `ui/kit/Input.tsx` | typecheck + 探针 |
| S3 | `IconBtn` / `MiniIconBtn` 收 `size` / `tone`，删 `className` | `ui/kit/IconBtn.tsx` | typecheck + 探针 |
| S4 | `Dropdown` 内部手写 button 改走 `Btn`，删 `className` / `menuClassName`，样式进 `.module.css` | `ui/kit/Dropdown.tsx` + `ui/kit/kit.module.css` | typecheck + 探针 |
| S5 | 新增 `api-scan.mjs`，锁 R4 | `tests/api-scan.mjs` | 扫描器自身 |
| S6 | 全局层拆出 `state.css` | `styles/tokens.css` `responsive.css` `state.css`（新建） | 探针 + 扫描器 |
| S7 | `ui/<组>` 目录迁移（overlays / shell / kit） | 多文件 | 探针 + 扫描器 |

**每步做完必须**：
```bash
cd app && npm run typecheck && npm test && node tests/color-scan.mjs && node tests/api-scan.mjs && npm run build && node tests/browser-smoke.mjs
```

**收尾**（踩坑 40）：`pkill -x chrome` 确认归零；`ss -ltnp` 查残留服务并 `kill`。

---

## 附录：当前违规清单（第一册要修的）

| 文件:行 | 违规 | 修法 |
|---|---|---|
| `ui/kit/Dropdown.tsx:53` | 收 `className?: string` | 删；布局由外层管 |
| `ui/kit/Dropdown.tsx:95-128` | 内部手写 2 处 `<button>` | 改走 `Btn` |
| `ui/kit/Btn.tsx:38-45` | 手写 `Record<Variant>` | 改 cva |
| `ui/kit/IconBtn.tsx` | 收 `className` | 删；布局由外层管 |
| `ui/kit/IconBtn.tsx` | `danger` / `primary` 两个布尔 | 合并为 `tone` prop |
| `ui/kit/Sheet.tsx:48` | `pb-[var(--kb,0px)]` | **不动**（运行时变量，扫描器已豁免） |
| `ui/settings/SettingsView.tsx:120` | `rounded-full`（Tailwind 自带） | 改 `rounded-[var(--r-pill)]`（第 3 册 N5 修） |
