# 第 6 册 · 数据实体与行为 — 违规清单与实施

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`entities-rules.md`](entities-rules.md)。
> 不变量：字段清单以 `domain/types/*` + `docs/业务模型.md` 为准，**本册不重写字段，只定行为归属**。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

| 位置 | 现象 | 结论 |
|---|---|---|
| `SyncResponse.snapshot.projects?` 可选 | 老响应落新客户端不炸 | E2 先例，留（新实体照抄） |

## 2. verify（2026-10-14）

- 判据3 通过：`views/` `app/` 无手写 `Object.values(s.tasks).filter`（查询只走 `domain/model`）。
- 判据4 **修掉一处泄漏**：`role === 'owner'` 散在 `ui/Members.tsx`×3（皇冠 + 两个禁用态）与
  `domain/model/cal.ts`×1（`resolveDefaultCal` 找 owner）—— 全改用 `canManage(role)`
  （定义即 `role === 'owner'`，逐字等价）。现在 `src/` 代码里 `role === 'owner'` 只剩
  `canWrite`/`canManage` 两处定义 + 注释。132 单测 + 探针（「创建者的移出按钮禁用」）全绿。
