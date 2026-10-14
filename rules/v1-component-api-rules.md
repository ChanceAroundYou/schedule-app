# 组件 API 与样式归属规范（第一册）

> 状态：**长期规则**（本册规则已定，实施另见 `v1-component-api-plan.md`）
> 依据：`ui/` `views/` `styles/` 逐文件审计 + 组件库现状（`docs/组件库.md`）+ 令牌三轴
> 不变量：**外部 import 路径一律不变**（barrel / 就地重构，调用方无感）；
>           `domain/` 保持零 React / DOM / 网络；后端只引 AI 那组依赖（见第 9 册 B5）。

---

## 0. 目标与判据

**目标**：把样式和功能打包成封闭组件，外观集中在 kit，调用方不叠外观类，想要别的样子就改 kit 或派生。零漂移和硬规则同等重要。

> **现状**：本册目标（外观集中进 kit + 样式按组打包）**已全部落地**。组件层用**普通
> `.css` 组文件**（`ui/<组>/<组>.css`），**不是 CSS Modules** —— S7 落地时按 plan §4 的
> 风险兜底退回普通 CSS：探针选中的类必须保持全局（不哈希），且 Vite 对 `@import` 的
> `.module.css` 不做 module 处理（字面 `:global(` + 双重注入打乱 cascade）。所有类全局，
> 组文件按既定顺序 `@import` 进 `tailwind.css`。
> 已落地：S1（`Btn` cva）· S3（`MiniIconBtn` tone）· S5（`api-scan.mjs`）· S6（`state.css` R3 白名单）· S7（6 组普通 CSS + 组件按组落位 + 调用方外观类 73→0）。
> 硬不变量（`api-scan.mjs` 锁）：`domain/` `views/` 零外观类；调用方外观类 0；`styles/` 只留全局 6 文件；`ui/**` 零 `.css` import。

**判据（怎么判成没成）**：
1. 外观归属被锁住 → `domain/` `views/` 零外观类（硬锁）+ 调用方只减不增（ratchet）
2. 每个 kit 组件外观走固定 `variant` / `tone` → props 有清单，`className` 只留布局类
3. 新增外观只改 kit 一处 → 目标 = 改一处，全部调用点自动跟

---

## 1. 样式归属三层（R1–R5）

### R1 三层边界

| 层 | 内容 | 归属 | 机制 |
|---|---|---|---|
| **全局层** | 令牌、响应式轴、降动静效、焦点环、跨组件状态类 | `styles/`（唯一） | 全局 CSS |
| **组件层** | `ui/**` 每个样式组一个 `.css` | `ui/<组>/<组>.css` | 全局 CSS（`@import` 进 tailwind.css） |
| **视图层** | `views/**` 的语义类名（冻结） | `styles/lists.css` `calendar.css` | 全局 CSS（**不动**） |

**为什么组 `.css` 绑"样式组"不绑组件**：
`Btn` 被几十处引用，若按组件拆成 `Btn.css`，该文件实际服务全 UI 层，不是 `Btn`。
`.task-row` 出现在 `lists` / `calendar` / `shell` 三个组里——**同一元素跨组复用**，按组件拆会把它撕成三个半套。

### R2 一个类名只有一个宿主

新写样式一律就近进组件的组 `.css`；发现同一类在第二处出现，先合并再谈别的。
这条直接掐死 `.jp-cell ×30` 那类扩散。

### R3 状态类协议白名单

`.on` `.open` `.dragging` `.today` `busy` `.done` 这类由 JS / dndkit 写的类，
集中列在全局层 `state.css` 一份清单里，注明「谁有权写」。`views/` 之外不得新增状态类。
理由：它们是跨文件契约，不是样式。

### R4 外观集中在 kit，调用方只减不增

**外观的合法宿主是 `ui/kit/**`**：新增外观（颜色 / 圆角 / 描边）先进 kit 一处，
调用方想要别的样子就改 kit 或派生，不散写。

调用方（`ui/` 非 kit、`app/`）**可以**用 Tailwind 工具类 + CSS 变量——这是本项目的
既有正确写法（CLAUDE.md 三、界面硬规则 里 `rounded-[var(--r-md)]` 就是推荐写法），
**但只减不增**：`tests/api-scan.mjs` 的 ratchet 锁着调用方外观类总数不许涨。

**两条硬锁**（`api-scan.mjs` 强制，出现即失败）：
- `domain/` 零 Tailwind 外观类（D1 纯净，domain 连样式都不碰）
- `views/` 零 Tailwind 外观类（D2 冻结，纯展示只用语义类）

### R5 机制

- 组 `.css` 按既定顺序 `@import` 进 `tailwind.css`（**零新依赖**，无 CSS Modules）
- `ui/**` 组件**不直接 import 任何 `.css`**（`api-scan.mjs` 锁）——样式只经 `tailwind.css` 进
- `views/**` 保持全局语义类，**不改名**（`parts.tsx` 开头：照抄 legacy、一个字不能改）

### R6 业务类 vs 样式类：彻底分家（2026-10-14 新）

**业务类**（business class）与**样式类**（style class）是两回事，不许混：

| | 业务类 | 样式类 |
|---|---|---|
| 是什么 | 组件**根元素**的语义类（`.task-row` `.when-pop` `.drawer` `.fast-fab`） | 组件**内部**子元素的视觉类（`.dp-cell` `.wp-row` `.fc-t`） |
| 回答 | 「这是**什么**组件」 | 「它**长什么样**」 |
| 归属 | 全局、稳定 | 关进组件的组 `.css`（全局，**不外泄**到别的组） |
| 谁能依赖 | 测试 / 探针 / 跨组件逻辑**只认它** | 只有组件自己 |

**四条硬规矩**：

1. **每个组件根必须挂一个业务类**（组件自带或调用方传），当稳定把手。
2. **样式类关在组件内部**：进该组件的组 `.css`，不写进别的组；改样式不破坏任何外部。
3. **测试除样式断言外，一律只用业务类选元素**，不碰样式类（样式断言走 `color-scan`/`contrast` 那批静态扫描，不在探针里）。
4. **状态类**（`.open` `.done` `.dragging`…）是**业务类**（协议，JS 写），留全局（`state.css` 白名单，见 R3）。

> 探针只认**业务类**（组件根，稳定），所以样式怎么组织（组 `.css` / 全局）都不影响探针——
> 前提是业务类确实稳定、确实挂在根上。

---

## 2. 组件 API 封闭化

### 2.1 每个组件只暴露固定 props

**判据**：props 有清单，外观走固定 `variant` / `tone`；`className` 只留**布局类**
（`flex-1` / `mt-*` / `w-*` 那批，见 2.4），不叠外观类。

| 组件 | 当前 props | 目标 props | 改动 |
|------|-----------|-----------|------|
| `Btn` | `variant` `size` `className` | `variant` `size` `className`(布局) | 变体进 cva；`className` 只留布局类 |
| `Input` | `dense` `className` | `dense` `className`(布局) | 无 variant 可 cva 化；`className` 只留布局类 |
| `IconBtn` | `label` `className` | `label` `className`(布局) | `className` 只留布局类（未加 `size`：无调用方需要，YAGNI） |
| `MiniIconBtn` | `label` `danger` `primary` `className` | `label` `tone` `className`(布局) | `danger`/`primary` 合并为 `tone`；`className` 只留布局类 |
| `Dropdown` | `className` `menuClassName` … | 不变 | 选项是 `role="option"`（listbox），改 `Btn` 会毁 A11y，**不改**；`className`/`menuClassName` 实测全是布局/定位类，已合规 |
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
| `tokens.css` | `:root` 变量集 | 全项目引用，下沉到组文件会断 |
| `responsive.css` | `@media` / `prefers-reduced-motion` / `:focus-visible` | **跨切面轴**，不属于任何单个组件；CLAUDE.md 明写必须压过 Tailwind `@layer` |
| `state.css` | R3 状态类白名单 | 跨组件协议，留全局 |

其余 `shell.css` `calendar.css` `lists.css` `quick-add.css` `overlays.css` 里**只服务 `ui/**`** 的部分，下沉到 `ui/<组>/<组>.css`（S7 已做）。


## 4. 与其他册的边界

- **第三册《命名》**：变量 / 文件 / 组件 / 类名 / CSS 变量
- **第四册《文件与目录》**：文件长度、文件夹划分、粒度、barrel 拆分
- **第五册《分层与数据流》**：`domain → data → views` 单向，`views/` 零回调判定
- **第六册《数据实体与行为》**：六条不变量 + 迁移 / 墓碑 / 游标

本册只覆盖：样式归属三层 + 组件 API 封闭化。不碰 `views/` 冻结类（见第 5 册 D2）、命名与文件（第 3/4 册）、数据流（第 5 册）。

---

