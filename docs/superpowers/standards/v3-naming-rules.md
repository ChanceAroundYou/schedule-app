# 编码规范第 3 册 · 命名

> 状态：**长期规则**（实施另见 `v3-naming-plan.md`）
> 依据：`docs/界面约定.md` §变量名与令牌、`CLAUDE.md` 三、令牌三条、
> `domain/types/*`、`domain/model/*`、`ui/kit/*`、`data-*` 实测清单
> 不变量：**外部 import 路径一律不变**；本册只定名字，不改任何导出。

---

## 1. 现状审计（实测）

- 文件命名：`ui/kit/*.tsx` PascalCase（`Btn.tsx→Btn`、`Card.tsx→Card/Field/Row`、`Chips.tsx→Chips`…）；
  `domain/model/*.ts` 全小写（`tasks.ts`、`habits.ts`、`make.ts`、`hydrate.ts`…）；
  `domain/types/*.ts` PascalCase（`Task.ts→Task`、`Cal.ts→Cal`…）；测试 `*.test.ts` 镜像源码。
- 桶文件：`ui/kit.tsx`、`views/parts.tsx`、`domain/types.ts`、`domain/types/types.ts` 只 re-export，无逻辑。
- CSS 变量（`tokens.css` 实测 40 个）：`--primary/--on-primary/--panel/--text/--input/--border/--danger/--warn/--ok`
  按**角色**命名；`--panel-2/--panel-3/--text-2/--text-3` 是同角色深浅档（允许的序号）；
  `--r-xs/sm/md/lg/xl/pill`、`--shadow(-md/-lg)/--border-w` 是风格轴档位。
- `data-*` 实测：`data-act×19`、`data-id×19` 为委托主协议；
  `data-nav/data-jump/data-jump-habits/data-view` 为导航；`data-date/data-zone-id/data-scope/data-kind`
  为视图定位；`data-cal-name/data-cal-save/data-add-habit` 为探针抓手。
- 选择器函数统一首参 `s: LocalState`（`liveTasks(s)`、`todayTasks(s)`、`counts(s)`…）。

---

## 2. 规矩

### N1 文件名 = 主导出名

- `ui/kit/Foo.tsx` 导出 `Foo`（`Card.tsx` 导出 `Card/Field/Row` 是布局原语三件套，特许一组）。
- `domain/types/Foo.ts` 导出 `Foo` 类型；`domain/model/foo.ts` 按行为分组（`tasks.ts` 查任务、`habits.ts` 查打卡）。
- 桶文件只 re-export，不写逻辑；新文件先查有无同类可复用（`rg` 一遍），再决定新建。
- 测试文件 `test_<module>.py` / `*.test.ts` 镜像源码结构（沿用工程规范）。

### N2 变量 / 函数：角色优先，查询统一签名

- CSS 变量按**角色**（`--input` 可操作描边 / `--border` 装饰线 / `--primary` 主色），不按序号；
  `--border-2` 类序号命名已灭（全仓 39 处改名完毕），**不许回潮**。
- domain 查询函数签名统一 `(s: LocalState, …)`，首参名固定 `s`；返回集合的按 `liveX/trashedX/xById` 命名
  （`liveTasks` / `trashedTasks` / `taskById` / `habitStreak` / `projectColumn`…）。
- 实体构造 `makeX`、补全 `hydrateX`、可见性 `isGone/isTrashed`——新实体照抄三件套，不另起名字。
- 选择器组件 props 统一 `value/options/onPick/label/labelledBy`
 （`Dropdown/Chips/SheetPicker` 三者一致，新选择器照抄）。

### N3 CSS 变量引用：无兜底值（真默认值除外）

- `.tsx` 里 `var(--x)` **一律不给兜底值**——写错名当场可见（声明失效→继承），不静默糊。
- 例外（真默认值，扫描器白名单）：`var(--kb,0px)`（无键盘时本就不存在）、
  `var(--cols,1)` / `var(--week-head-h,79px)`（JS 内联设置前的默认值）。新增例外需进白名单+注释理由。
- 判据由 `contrast.mjs` ③④段锁（未定义变量 / 多余兜底值）。

### N4 `data-*`：协议分三类，探针抓手走透传

| 类 | 属性 | 谁读写 |
|---|---|---|
| 委托 | `data-act` + `data-id` | `views/` 只写，`clickDispatch.ts` 只读；新增动作先在 `runAct` 加 case |
| 导航 | `data-nav/data-jump/data-jump-habits/data-view` | 同上，`useNav` 消费 |
| 定位/探针 | `data-date/data-zone-id/data-scope`、`data-cal-name/data-cal-save/data-add-habit` | 定位由视图写、拖拽/探针读；探针抓手**只走** `inputProps/confirmProps` 透传，不硬编码进组件 |

- 不新增 `data-*` 方言：想要新语义先查上表，归不进三类才加，且同步更新本表。

### N5 类名：语义类冻结，Tailwind 只在 kit 内

- `views/**` 语义类（`task-row/task-el/month-cell/check-btn…`）**冻结**——照抄 legacy，一个字不改（`parts.tsx` 头）。
- Tailwind 工具类只许出现在 `ui/kit/**` 内部（第 1 册 R4），调用方/`views/` 不写。

---

## 3. 判据

1. `contrast.mjs` ③④段 0 报错（未定义变量 / 多余兜底值）。
2. 新增文件 `rg` 无同类实现；文件名与主导出一致（抽查）。
3. 新增 `data-*` 必进 N4 表，否则 `api-scan.mjs` 报错（第 1 册 plan §2 扩一条）。

---

