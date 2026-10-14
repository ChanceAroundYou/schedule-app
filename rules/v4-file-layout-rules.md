# 编码规范第 4 册 · 文件与目录

> 状态：**长期规则**（实施另见 `v4-file-layout-plan.md`）
> 依据：全局 `security-review.md`（800/50/4层）、
> `docs/重构-组件合并-实施spec.md` §7、实测目录树 + barrel + 最长文件快照
> 不变量：**外部 import 路径一律不变**；本册只定放哪和多大，不动任何逻辑。

---

## 1. 现状审计（实测）

- 目录：`app/ data/ domain/ styles/ sync/ ui/ views/` 一级；`ui/` 下二级
  `aipanel/ calendars/ dnd/ drawer/ hooks/ kit/ settings/ shell/`，按**功能组**划分。
- barrel：`ui/kit.tsx`（`export * from './kit/kit.ts'`）、`ui/hooks.ts`、`ui/shell/shell.ts`、
  `views/parts.tsx`、`domain/types.ts`——全部只 re-export，头部注释写明"保持 import 路径不变"。
- 最长文件：`AiPanel.tsx` 313 行 → 800 上限**无压力**；server 最长 `calendars.js` 228 行。
- 函数长度：逻辑函数**全部 ≤50 行，无特许**——`normalizeUi`/`migrateV3` 已按逻辑单元拆成
  `normalizeDayWindow`/`normalizeNav`、`migrateTasks`/`migrateTrash`/`migrateHabits`；
  `Dropdown` 按部件拆成 `Dropdown`/`DropdownMenu`/`handleKeyDown`，逻辑单元各 ≤50。

---

## 2. 规矩

### F1 文件长度：800 行硬顶，300 行软线

- 单文件 **≤800 行**（含注释）——超了必须拆，拆法只许 barrel 模式（F4）。
- **300 行是软线**：超 300 先问"是不是混了两件事"（如 `AiPanel` = 状态+发送+气泡列表混）。
  问完仍内聚（如注释占一半的 `DayView` 249 行），留。
- 函数 **≤50 行，无例外**：超了先 early return 压嵌套，再按逻辑单元拆（并列字段/分支
  各自成函数）。React 组件按部件拆（触发器/菜单/键盘各成函数），逻辑单元各 ≤50——
  组件的 props 类型与 JSX 是声明，不计入逻辑行数。
- 嵌套 **≤4 层**：超了抽函数或反转条件；`switch` 穿透用 `noFallthroughCasesInSwitch` 锁（tsconfig 已开）。

### F2 粒度：按行为分组，不按实体切碎

- `domain/model/` 按**行为**分文件（`tasks.ts` 查任务、`make.ts` 构造、`hydrate.ts` 补全、
  `visibility.ts` 可见性、`permission.ts` 权限），不按 Task/Habit/Project 三个实体各建一套。
- `ui/<组>/` 按**功能组**分目录（`shell/` 外壳、`drawer/` 抽屉、`aipanel/` AI 面板），
  不按 Btn/Input 每个组件建目录。
- 新文件三问（按序）：① `rg` 有无同类可复用 → ② 该行为归哪个现有文件 →
  ③ 都不归才新建。新建即配 barrel 导出。

### F3 目录：七层一级目录冻结，二级按组

- 一级 `app/ data/ domain/ styles/ sync/ ui/ views/` **不增不减**——新代码先归位，归不进才讨论。
- `ui/` 二级按功能组；`views/` 下按页面（`lists/`、`calendar/`）+ 共享 `parts/`；
  `domain/` 下 `types/`（形状）与 `model/`（行为）分离——**形状与行为不放同一文件**。
- `server/` 下 `lib/` 按域（`db/auth/sync/calendars/invites/ratelimit`）+ `lib/ai/` 唯一碰 pi 处；
  `server/data/` gitignored，**永不进仓库**。

### F4 拆分只许 barrel 模式

- 拆出的子组件放**同目录**，主文件 import 它们、自身导出不变（`CalItem`、`AiBar`、`FastSide`、
  `SearchInput` 四个先例，见重构 spec §7）。
- barrel 文件只 re-export，不写逻辑、不改名（公开 API 与拆分前逐字相同）。
- `about` 段、FAB 这类与主文件状态强耦合的**不拆**（拆出去透传 3+ 回调即停）。

---

## 3. 判据

1. 全仓无超 800 行文件（`wc -l` 抽查，CI 可加）。
2. 拆分 PR diff 显示外部 import 路径零改动。
3. 新文件附三问结论（一句话写进 PR 描述或文件头注释）。

---

