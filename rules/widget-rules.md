# 编码规范第 10 册 · Android 桌面小组件

> 状态：**长期规则**（规则已定，实施另见 widget-plan.md）
> 依据：`app/android/app/src/main/java/space/xiaokubao/schedule/`（ScheduleWidgetProvider / WidgetData / RepeatSpawn / WidgetApi / TaskDetailActivity / CreateTaskActivity / WidgetSettingsActivity）、`app/src/domain/widgetSnapshot.ts`、`app/src/data/widget.ts`、`docs/架构决策.md` 五、小组件
> 不变量：小组件**只约束 Android 桌面小组件**（ScheduleWidgetProvider 这类）—— 不扩展到 Capacitor 容器或一般原生 Activity / 设置页。网页与小组件共享**同一权威数据模型**，RemoteViews 的限制只能作为明文例外，不静默改变业务含义。

---

## 0. 目标与判据

**目标**：小组件是「同一权威数据模型的受限交互端」，不是网页的简化副本。所有任务 / 打卡 / 权限 / 同步 / 重复语义与网页一致；视觉令牌与信息层级保持同一语言；只有受 RemoteViews / 离线队列 / 空间限制影响的展示与交互允许有明确例外。

**判据**：
1. 业务语义一致：小组件展示的任何任务字段、状态（完成 / 逾期 / 重复实例）的判定口径与网页完全相同
2. 共享通道唯一：网页 ↔ 小组件数据只经 `@capacitor/preferences` 的 MODE_PRIVATE `SharedPreferences` + 广播刷新，不另起通道
3. 例外明文化：任何视图 / 交互差异必须在 §4「允许例外」表中列出理由， silently 降级算违规
4. 不在小组件内做业务判断：小组件不自算逾期 / 不自 spawn 重复，只渲染快照

---

## 1. 范围

**在册**（仅桌面小组件）：
- ScheduleWidgetProvider（RemoteViews 渲染 + 点击 PendingIntent + 刷新）
- WidgetData（SharedPreferences 读写 + 快照 schema）
- RepeatSpawn（重复 spawning 的 worker，由 WidgetApi 触发）
- widget 专属 Receiver（ReminderReceiver）

**不在册**（明确排除）：
- Capacitor 容器（`MainActivity` / `Ui` / 业务页）
- 一般原生 Activity（`TaskDetailActivity` / `CreateTaskActivity` / `WidgetSettingsActivity`）—— 虽在同目录，归 app 层
- Capacitor 插件桥（`WidgetBridge`）

> 之所以把 Activity 排除在外：它们不是 RemoteViews 受限，不能把「不能启动 Activity」这种小组件限制强加到它们身上，反而要求它们遵守网页那一套充盈交互。混淆两类会把规则写成自相矛盾。

---

## 2. 单一权威

1. **真相在服务器 SQLite**（与第 6 册 / AGENTS.md 二一致）。小组件从不作为权威，永远是快照的消费者。
2. **快照是派生，不是第二份真相**：小组件本地不持任务状态；每次刷新从 SharedPreferences 读当前快照并渲染。快照过期 = 显示旧数据，但不能根据它做出写决策。
3. **写 always 回去服务端**：小组件上的勾选 / 改期 / 新建全部走 `WidgetApi → server`（或 `@capacitor/preferences` 的 outbox），再由同步把后果推回；小组件只轮询 / 接收广播。
4. **禁止小组件内 spawn 重复**：重复规则的 spacing / advance 由服务端 `repeatNext` 决定；`RepeatSpawn` 只是在本地把已 spawn 的新实例落进 SharedPreferences 快照，不入库。

---

## 3. 共享语义（不得与网页分叉）

| 语义 | 网页口径 | 小组件要求 |
|---|---|---|
| 逾期 | `!done && date && date < today` | 完全相同 |
| 三态（未定时 / 未定日期 / 已完成占位） | 第 6 册 | 完全相同 |
| 重复实例 id | `${根}#${发生日}` | WidgetData 必须原样携带，禁止重编 |
| 权限 | `canWrite` / `canManage` | 小组件所有可操作入口都要来自同步后的角色快照；渲染上可按角色降级，但**后台写 API 仍按 db.roleOf() 严审** |
| 完成态 | `TaskSnapshot.done` | 直接读字段 |

任何一处发现「小组件拿的是另一套计算」算违规 → 修到一致，不为此发明分叉捷径。

---

## 4. 允许例外（RemoteViews / 空间 / 离线）

| 限制源 | 允许的例外 | 明文要求 |
|---|---|---|
| RemoteViews | 仅 RemoteViews 支持的组件 | 仅 View、LinearLayout、TextView、ImageView、ImageButton、ListView、GridView 等；圆角走 .9patch 资源，不能跑 CSS |
| 离线队列 | 仅展示层 | 本地可缓存挂起操作（勾选/延后）并在联网后由 WidgetApi 重试；**不能**利用缓存决定是否显示某条任务 |
| 30 分钟刷新间隔 | 显式广播 + 下拉刷新 | 不能用间隔推算「这条一定过时了」； Freshness 靠 `WidgetData.lastSyncAt` |
| 清单空间 | 截断 +「还有 N 条」 | 不能为了让某一条显示而改变排序；排序跟随网页 |

任何**不列在此表**的差异 = 违规，无例外。

---

## 5. 实施状态

- 本册 rules **刚立**（2026-10-15），实施随开发推进。
- plan 文件 `widget-plan.md` 列出当前小组件未收敛点。

---

## 6. 裁决与依据

用户裁定（2026-10-15）：
- 范围：仅现行技术栈的 Android 桌面小组件，**不**含 Capacitor 容器与一般原生页。
- 任何语义必须与网页一致，RemoteViews 限制仅作明文例外。

**本册新增一项额外要求**：`widgetSnapshot.test.ts` 与 `widgetSnapshot` 的快照字段变更一律需在小组件端同步 schema；不改动字段时不必双端 smoke。


---

## 7. 跨册引用

| 册 | 与第 10 册的关系 |
|---|---|
| 6（数据实体） | 小组件不重算实体，仅渲染快照（§2.4） |
| 9（后端） | WidgetApi 走同步 / REST 入口（§2.3），权限仍由 `db.roleOf()` 严审 |
