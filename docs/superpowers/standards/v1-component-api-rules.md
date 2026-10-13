# 组件 API 与样式归属规范（第一册）

> 状态：**长期规则**（本册规则已定，实施另见 `v1-component-api-plan.md`）
> 依据：`ui/` `views/` `styles/` 逐文件审计 + 组件库现状（`docs/组件库.md`）+ 令牌三轴
> 不变量：**外部 import 路径一律不变**（barrel / 就地重构，调用方无感）；
>           `domain/` 保持零 React / DOM / 网络；后端不引任何新依赖。

---

## 0. 目标与判据

**目标**：把样式和功能打包成封闭组件，调用方不写样式、不叠 `className`，想要别的样子就改组件或派生。零漂移和硬规则同等重要。

**判据（怎么判成没成）**：
1. 扫描器能抓出「调用方手写 Tailwind 外观类」→ 目标 = 抓出 0 处
2. 每个 kit 组件只暴露固定数量 props → 目标 = props 有清单，无 `className` 透传
3. 新增外观只改 kit 一处 → 目标 = 改一处，全部调用点自动跟

---

## 1. 样式归属三层（R1–R5）

### R1 三层边界

| 层 | 内容 | 归属 | 机制 |
|---|---|---|---|
| **全局层** | 令牌、响应式轴、降动静效、焦点环、跨组件状态类 | `styles/`（唯一） | 全局 CSS |
| **组件层** | `ui/**` 每个样式组一个 `.module.css` | `ui/<组>/<组>.module.css` | CSS Modules |
| **视图层** | `views/**` 的语义类名（冻结） | `styles/lists.css` `calendar.css` | 全局 CSS（**不动**） |

**为什么 `.module.css` 绑"样式组"不绑组件**：
CSS Modules 每个 Module 文件 = 一套独立的类名改写表，Module 自己不知道被谁 import。`Btn` 被 50 处引用，若都写 `Btn.module.css`，该 module 实际服务全 UI 层，不是 `Btn`。
`.task-row` 出现在 `lists` / `calendar` / `shell` 三个组里——**同一元素跨组复用**，按组件拆会把它撕成三个半套。

### R2 一个类名只有一个宿主

新写样式一律就近进组件的 `.module.css`；发现同一类在第二处出现，先合并再谈别的。
这条直接掐死 `.jp-cell ×30` 那类扩散。

### R3 状态类协议白名单

`.on` `.open` `.dragging` `.today` `busy` `.done` 这类由 JS / dndkit 写的类，
集中列在全局层 `state.css` 一份清单里，注明「谁有权写」。`views/` 之外不得新增状态类。
理由：它们是跨文件契约，不是样式。进 CSS Module 会被改写名、协议断。

### R4 Tailwind 工具类只许出现在 kit 组件内部

`ui/` `app/` 调用方、`views/` 一律不写 Tailwind 类。想要别的样子就改 kit 或派生。
这是「样式+功能打包进组件」的落点。

### R5 机制与豁免

- `ui/**` 用 CSS Modules（Vite 内置，**零新依赖**）
- 需要逃逸到全局的地方显式写 `:global(.xxx)`，**只有** R3 状态类白名单里的类才准写
- `views/**` 保持全局语义类，**不 scoped 改名**（`parts.tsx` 开头：照抄 legacy、一个字不能改）

---

## 2. 组件 API 封闭化

### 2.1 每个组件只暴露固定 props

**判据**：props 有清单，无 `className` 透传（除布局类白名单）。

| 组件 | 当前 props | 目标 props | 改动 |
|------|-----------|-----------|------|
| `Btn` | `variant` `size` `className` | `variant` `size` | 删 `className`；布局由 `Row`/`gap` 管 |
| `Input` | `dense` `className` | `dense` | 删 `className`；尺寸由外层容器管 |
| `IconBtn` | `label` `className` | `label` `size` | 删 `className`；尺寸收进 `size` |
| `MiniIconBtn` | `label` `danger` `primary` `className` | `label` `tone` | `danger`/`primary` 合并为 `tone`；删 `className` |
| `Dropdown` | `className` `menuClassName` … | 无 `className` | **先修**：内部手写 2 处 `<button>` 改走 `Btn`；面板样式进 `.module.css` |
| `Chips` | `label` `labelledBy` … | 不变 | 已是 `Btn` 封装，无需改 |
| `Sheet` | `footer` `dismissable` … | 不变 | 已是封闭的 |

### 2.2 变体用 cva，不用手写 `Record`

`package.json` 里 `class-variance-authority` 和 `@radix-ui/react-slot` **装了但全项目零调用**。
`Btn.tsx` 在手写 `Record<Variant>`。第一册起：

```ts
import { cva, type VariantProps } from 'class-variance-authority';

const btnVariants = cva(
  // 基类：所有 variant 共享
  'btn inline-flex items-center justify-center gap-1.5 rounded-[var(--r-md)] font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-95 active:brightness-90',
        normal: 'border-[length:var(--border-w)] border-[var(--input)] bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] hover:border-[var(--text-3)]',
        ghost: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)]',
        danger: 'border-[length:var(--border-w)] border-[var(--danger)] bg-transparent text-[var(--danger)] hover:bg-[var(--danger-soft)]',
        chip: 'border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel)] text-[var(--text-2)] hover:border-[var(--primary)] hover:text-[var(--primary)]',
        chipOn: 'border-[length:var(--border-w)] border-[var(--primary)] bg-[var(--panel)] font-medium text-[var(--primary)]',
      },
      size: {
        sm: 'h-[30px] px-2.5 text-[12.5px]',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-11 px-5 text-[15px]',
      },
    },
    defaultVariants: { variant: 'normal', size: 'md' },
  },
);
```

**好处**：
- variant 和 size 正交，新增一档不用改 `Record` 的 key
- TypeScript 推导精确，写错 variant 当场报错
- 样式集中在 cva 定义里，改一处全部跟

### 2.3 派生 = 新 cva 共享基类，不用 Slot

需要「长得像 Btn 但语义不同」的组件（`IconBtn` / `MiniIconBtn`），各写自己的 cva，**共享同一份基类常量**，不叠 `className`：

```ts
// ui/kit/base.ts —— 共享基类（不是组件，只是常量）
export const BTN_BASE =
  'inline-flex items-center justify-center font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

// Btn.tsx
const btnVariants = cva(cx(BTN_BASE, 'gap-1.5 rounded-[var(--r-md)]'), { variants: { … } });

// IconBtn.tsx —— 同基类，但圆角/尺寸不同
const iconBtnVariants = cva(cx(BTN_BASE, 'rounded-[var(--r-pill)]'), { variants: { … } });
```

**不用 `@radix-ui/react-slot`**：asChild 解决的是「把按钮渲染成 Link」这种换宿主元素的场合，本项目没有（所有派生组件仍是 `<button>`）。装着未用 ≠ 该用。

派生组件（`ui/kit/` 内部新文件）可以重定义外观，但**必须仍然只走 cva variant + 令牌**，不许在派生里出现 Tailwind 的颜色/圆角/描边类。改样式的权力在 kit 内部，不在调用方。

### 2.4 布局由外层管，不由 className 透传

调用方需要「这个按钮宽一点」「那两个按钮之间留 8px」，走 `Row` / `gap` / `flex-1`，不走 `className="w-[120px]"`。

```tsx
// 对：
<Row>
  <Btn variant="primary" className="flex-1">保存</Btn>
  <Btn variant="normal">取消</Btn>
</Row>

// 错：
<Btn variant="primary" className="w-[200px] mt-2 ml-3">保存</Btn>
```

`flex-1` / `mt-*` / `ml-*` 这类布局类是**唯一**允许调用方写的类，因为它们不改外观，只改排版。

---

## 3. 全局层保留三份

| 文件 | 内容 | 为什么留在全局 |
|---|---|---|
| `tokens.css` | `:root` 变量集 | 全项目引用，下沉到 module 会断 |
| `responsive.css` | `@media` / `prefers-reduced-motion` / `:focus-visible` | **跨切面轴**，不属于任何单个组件；CLAUDE.md 明写必须压过 Tailwind `@layer` |
| `state.css`（新增） | R3 状态类白名单 | 跨组件协议，进 module 会被改写名 |

其余 `shell.css` `calendar.css` `lists.css` `quick-add.css` `overlays.css` 里**只服务 `ui/**`** 的部分，下沉到 `ui/<组>/<组>.module.css`。


## 4. 与其他册的边界

- **第二册《命名与文件》**：变量名、文件长度、文件夹划分、粒度
- **第三册《分层与数据流》**：`domain → data → views` 单向，`views/` 零回调判定
- **第四册《数据结构与 SQLite》**：六条不变量 + 迁移/墓碑/游标

本册只覆盖：样式归属三层 + 组件 API 封闭化。不碰 `views/` 冻结类（见第 5 册 D2）、命名与文件（第 3/4 册）、数据流（第 5 册）。

---

