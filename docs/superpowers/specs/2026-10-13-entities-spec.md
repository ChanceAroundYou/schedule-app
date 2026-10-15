# 编码规范第 6 册 · 数据实体与行为

> 状态：**待审核**（spec 已产出，实现未开始）
> 依据：`domain/types/*`（Task/Habit/Project/Op/SyncMeta/Cal/RepeatRule）、
> `domain/model/*`（make/hydrate/visibility/tasks/project/permission/migration/id）、
> `docs/业务模型.md` §数据结构、`data/store/commit.ts`、`data/store/moveToCal.ts`
> 不变量：字段清单以 `domain/types/*` + `docs/业务模型.md` 为准，**本册不重写字段，只定行为归属**。

---

## 1. 现状审计（实测）

- 类型：`Task.ts` 52 行 / `Habit.ts` / `Project.ts` / `Op.ts` / `SyncMeta.ts` / `Cal.ts` /
  `RepeatRule.ts`，每字段有注释（`date null=待办箱`、`doing` 与 `done` 独立、`projectId` 可选零迁移）。
- 完整字段表：`docs/业务模型.md` §数据结构（`LocalState` 24 键 + Task/Project 全字段）。
- 行为：`domain/model/` 12 文件——`make`（构造）/`hydrate`（补全半个实体）/`visibility`
  （`isGone/isTrashed`）/`tasks`（`liveTasks/todayTasks/overdueTasks/counts`…）/`project`
  （`projectColumn/projectProgress/projectTouchedAt`…）/`permission`（`roleOf`）/`migration`/`id`。
- 六道口子实测：`make*` 构造 → `hydrate*` 补全 → `model/*` 查询 → `commit/commitMany` 本地写 →
  `remote.applyRemote/flattenSnapshot` 远端落地 → `moveToCal` 跨集搬运（自带把关）。
- 可选字段零迁移先例：`projectId`（缺=没归属）、`snapshot.projects`（缺=没项目）——
  行为与加字段前逐像素相同，不写 migration。

---

## 2. 规矩

### E1 六道口子（新行为先查表再落子）

| 口子 | 函数 | 谁调 |
|---|---|---|
| 构造 | `makeTask/makeHabit/makeProject` | 新建实体唯一入口；墓碑字段只在传了才写（不写 `deleted: undefined` 空洞） |
| 补全 | `hydrateTask/hydrateHabit/hydrateProject` | 外部数据进 state 必过（增量只带 `{title}` 会 TypeError 的坑见文件头） |
| 可见性 | `isGone/isTrashed` | `liveX/trashedX` 唯一判据；别处不许手写 `deleted === true` |
| 查询 | `model/tasks|habits|project|counts` | 页面只调查询函数，不手写 `Object.values(s.tasks).filter` |
| 本地写 | `commit/commitMany`（+`moveToCal`） | 唯一写入口；同批共用一 `ts` |
| 远端落地 | `applyRemote/flattenSnapshot` | 增量 vs 快照两路；快照不判冲突（见 E4） |

### E2 可选字段零迁移

- 新字段默认可选（`field?: T | null`），缺字段按旧行为处理——旧任务/旧 op/旧快照不炸。
- 判据：加字段 PR 必须带"缺字段行为"一句话（`projectId`：没归属；`snapshot.projects`：没项目）。
- 只有"缺了会误判"（如权限/主键类）才写 migration；UI 文案类一律零迁移。

### E3 派生与本地性

- 实例 id = `seriesId#日期`（`instanceId(根, 发生日)`）——两端离线派生同一 id，同步合并 Volunteer 不翻倍。
  **id 生成规则一改，同步即分叉**，动它等于换协议。
- `calId/_ts/_dev` 只存本地、不进 op 的 fields（`calId` 是主键的一部分，改归属=换实体，走 `moveToCal`：目标集新建+源集留墓碑）。
- 防死循环判据是"必须往前走"（`next > cursor`），**不是魔法数字上限**（`guard<800` 已证伪，见业务模型）。

### E4 冲突与口径

- 冲突 = 同一字段两边都改（`findConflicts(推上去的op, 拉回来的变更)`），`winner` 按 `(ts, deviceId)`；
  提示显示输方值、配色 `--warn` 非报错红；记录落盘、上限 50、同键顶掉。
- 快照不判冲突（刚进集拉全量，判即误报一片）。
- 口径唯一性：逾期 `!done && date && date < today`；`counts().today` 不含逾期；
  `Pulse` 进度分母含已完成（与徽标故意不同）；三态（未定时/未定日期/完成仍占段）独立。

### E5 功能归属表（新函数落子前查）

| 行为 | 住哪 |
|---|---|
| 任务查询/排序/位次（`todayTasks/orderCmp/nextOrder`） | `model/tasks.ts` |
| 打卡/连击（`habitStreak/habitsTodayRemaining`） | `model/habits.ts` |
| 项目列/进度/活跃（`projectColumn/projectProgress/projectTouchedAt`） | `model/project.ts` |
| 角色/归属（`roleOf/inCal/resolveDefaultCal`） | `model/permission.ts` + `model/cal.ts` |
| 重复推进（`repeatNext/repeatAdvance/seriesRootOf/instanceId`） | `domain/repeat.ts` |
| 合并/LWW/冲突判定（`writeFields/findConflicts`） | `domain/merge.ts` |

---

## 3. 判据

1. 新实体照抄 `make/hydrate/visibility` 三件套（命名见第 3 册 N2）。
2. 加字段 PR 有"缺字段行为"一句话；无 migration 时说明为什么零迁移够。
3. 页面无手写 `Object.values(s.tasks).filter`（有查询函数不用即违规，`api-scan.mjs` 可锁）。
4. `role === 'owner'` 只出现在 `canWrite/canManage/db.roleOf`（`rg` 全仓 = 3 处定义）。

---

## 4. 违规清单（本册不修，只记）

| 位置 | 现象 | 结论 |
|---|---|---|
| `hydrateTask` 50 行 | 12 个并列 if | 第 4 册 F1 特许形态，留 |
| `SyncResponse.snapshot.projects?` 可选 | 老响应落新客户端不炸 | E2 先例，留（新实体照抄） |
| `overlays.css .check-circle border:#fff` 写死 | 白勾压浅绿 `--primary` 对比度 ~2:1 | 真 bug，属颜色，待第 8 册或单修（重构 spec 附录 A 已记） |
