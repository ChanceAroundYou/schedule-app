# 第 4 册 · 文件与目录 — 违规清单与实施

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`file-layout-rules.md`](file-layout-rules.md)。
> 不变量：**外部 import 路径一律不变**；本册只定放哪和多大，不动任何逻辑。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

| 位置 | 现象 | 结论 |
|---|---|---|
| `data/store/tasks.ts` 813 行 | **超 800 硬线** | 混了新建 / 重复展开 / 勾选 / 删除 / 垃圾箱五件事 —— 按 F4 barrel 拆（待办） |

## 2. verify（2026-10-25 复核）

F1 **未通过**：`data/store/tasks.ts` 813 行超 800 硬线。其余超 300 软线的（`TaskCard.tsx` 669、`domain/layout.ts` 404、`app/clickDispatch.ts` 392）逐个看过，均内聚，留。
**函数全部 ≤50 行，无特许**（`normalizeUi`/`migrateV3` 按逻辑单元拆、`Dropdown` 按部件拆，见 rules F1）。
