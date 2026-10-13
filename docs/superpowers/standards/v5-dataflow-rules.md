# 编码规范第 5 册 · 分层与数据流

> 状态：**长期规则**（实施另见 `v5-dataflow-plan.md`）
> 依据：`app/clickDispatch.ts`、`data/store/commit.ts`、`ui/hooks/store.ts`、
> `CLAUDE.md` 一、结构 + 二、不变量、`docs/重构路线*.md`
> 不变量：**外部 import 路径一律不变**；`domain/` 保持零 React / DOM / 网络；本册只定流向，不动逻辑。

---

## 1. 现状审计（实测）

- `domain/` 纯度：**已验纯净**（零 React/DOM/网络 import，可在 Capacitor 与 Node 跑）。
- `views/` 回调：**已验 0 处** `onX` props；行内按钮只写 `data-act` + `data-id`。
- 委托链：`#content` 上一个 `onClick`（`clickDispatch.ts`），四步从具体到笼统
  `[data-act]` → `[data-jump]/[data-nav]/[data-jump-habits]` → `.task-el`（开抽屉）→ `[data-drop]`（空白新建）；
  另有一个 `onChange`（`next-project` 这类输入控件，change≠click）。
- 状态分叉：`useStoreState()` 拿全量，`useScopedState()` 按 `ui.cals`（勾选集）过滤出
  `tasks/habits/projects` 子集；今天/逾期/待办箱/垃圾箱用全量，日程/打卡/已完成/项目用 scoped；
  侧栏徽标与顶栏一律全量口径。
- 写入双把关：本地 `commitMany()`（`data/store/commit.ts`：`canWrite(roleOf)`，挡下记 `deny()`）
  与远端 `sync.applyOps()`（服务端 `canWrite(db.roleOf())`）各挡一次；`moveToCal` 自带一道（不走 commitMany）。
- 读取：`useStoreState / useScopedState / useStoreSelector` 三个 hook；`store.get()` 只在事件处理与
  委托链里读快照，不在渲染路径里直读。
- AI 即另一台设备：读 `sync.snapshot(userId)`、写 `sync.applyOps(userId, ops)`、`deviceId='ai'`；
  提案按 `toolCallId` 关联，`POST /api/ai/confirm` 只信 id 不信参数、重查权限。

---

## 2. 规矩

### D1 单向依赖，只许下指上

```
domain（纯） ← data（store/设备） ← sync（outbox+游标） ← app（装配/委托） ← ui/views（展示）
```

- `domain/` 不 import 上面任何一层（已验纯净，探针/单测锁）。
- `views/` 只 import `domain/types`（形状）+ `domain/model`（查询）+ `ui/kit`（组件）；
  不 import `data/store` 写入口（`commit/patch/toggle` 一律不许出现在 views 里）。
- `server/lib/ai/` 是唯一碰 pi 处；`confirm.js` 纯 DB 操作，不碰 pi。

### D2 `views/` 零回调判定（三条全满足才算过）

1. 无 `onX` props（`rg 'on[A-Z].*:' views/` = 0 处）；
2. 行内交互只出 `data-*`（`data-act` + `data-id`，导航类见第 3 册 N4）；
3. 受控输入的 `onChange`（如 `dense` 输入框打字）与折叠开关的本地 `useState` 允许——
   纯 UI 态，不写 store（判定标准：onChange 里无 `store.*` 调用）。

- 新增动作流程：在 `views/` 加 `data-act="xxx"` → 在 `runAct` 加 case（`clickDispatch.ts` 头有说明）。
  **别往行上挂 onClick**（拖拽/同步会换掉节点，handler 跟着丢）。

### D3 状态分叉：跨集 vs 按集一次定，下游不动

| 拿全量 `state` | 拿 `scoped` |
|---|---|
| 今天 · 逾期 · 待办箱 · 垃圾箱 · 侧栏徽标 · 顶栏 | 日程 · 打卡 · 已完成 · 项目 |

- 在 `Workbench/contentDispatch` 传哪份 state 定一次；**不给 views 选择器加 `calId` 参数**
  （下游十几个选择器只认 `s.tasks/s.habits`，加参等于每处重过滤一遍）。
- `ui.cals`（勾选=看哪几个）与 `ui.cal`（归属=新建落哪）是两件事；`toggleCal()` 保证归属集一定勾着。
- 至少永远勾着一个集；一个没勾 = 空 state，是用户主动选择，不是 bug。

### D4 写入双把关，挡下必须说出来

- 本地 `commitMany()` + 远端 `applyOps()` 各挡一次（`canWrite(roleOf)`）；
  `moveToCal`（新建+墓碑，不走 commitMany）自己挡一道。
- 被挡下的改动记 `denied+1` + `deniedCals` 点名是哪个集，App 弹一次提示——
  **写操作不许静默失败**（藏按钮是体验优化，不是关卡）。
- 同一次用户操作共用一个 `ts`（`commitMany` 内单次 `Date.now()`），回放对得上账。

### D5 读取只走三个 hook

- 渲染路径：`useStoreState()`（全量）/ `useScopedState()`（按集）/`useStoreSelector(pick)`（派生值）。
- `store.get()` 只许在事件处理/委托链/一次性快照里用；渲染函数里直读 `store.get()` 即违规
  （订阅断了，同步落地不重渲染）。
- 瞬时态（`syncing`）**不落盘**（load 时重置）；`conflicts` **故意落盘**（点了"知道了"前一直在）。

### D6 AI 写路径三段，复用同步通道

- 工具 `execute` 只造提案（`Map<toolCallId, proposal>`），不落库——强制是结构性的，不用 `beforeToolCall` 拦。
- 提案按 `toolCallId` 关联（pi 并行，不按执行顺序）。
- `POST /api/ai/confirm` 唯一落库：按 id 读回提案、**重查权限**、走 `applyOps`。
  客户端回传 args 不可信（等于把权限判交给浏览器）。

---

## 3. 判据

1. `domain/` 无 React/DOM/网络 import（`rg "from 'react'|document\.|window\.|fetch\(" domain/` = 0）。
2. `views/` 无 `onX` props、无 `data/store` 写入口 import。
3. 新增 `data-act` 必有 `runAct` 对应 case，否则 `api-scan.mjs` 报错（第 1 册 plan §2 扩两条：D1+D2）。
4. 跨集/按集页面清单与 D3 表一致（抽查 `contentDispatch`）。

---

