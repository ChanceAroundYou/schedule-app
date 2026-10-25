# 第 5 册 · 分层与数据流 — 违规清单与实施

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`v5-dataflow-rules.md`](v5-dataflow-rules.md)。
> 不变量：**外部 import 路径一律不变**；`domain/` 保持零 React / DOM / 网络；本册只定流向，不动逻辑。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

| 位置 | 现象 | 归属 |
|---|---|---|
| `views/` 受控 `Input onChange` ×N | 打字本地态，无 store 调用 | 合规（本地态，非 store 写，不触 D2） |
| `Dropdown` 触发器/选项手写 `<button>` | ARIA listbox 部件，非动作按钮 | 第 1 册 S4 已定：listbox 部件不适用 Btn（`role="option"`），保持手写 + 完整 ARIA（收在 `DropdownMenu`） |

## 2. verify（2026-10-14）

- **D1 破口闭合**：原先 5 处 views import `reorder`/`reorderList`（`data/store/sort.ts`，
  走 `commitMany`）—— 拖拽排序的写入口散在 views 里。修法是把 **dnd→store 的耦合搬进
  `ui/dnd/sortable.tsx` 的 `SortableList`**：它收 `entity: 'task'|'habit'`（普通字符串
  prop，不是回调），拖完自己 `reorder(entity, 新顺序)` 写库。views 只声明「哪类实体的
  列表」，不再碰 `data/`。`ui/` 引 `data/store` 是既有模式（CalItem/CalRow 等 8 处先例），
  合规。死代码 `reorderList` 已删。
- 现在 `views/` 零 `data/store` import、零 `onReorder`。**扫描器已补锁**：`api-scan.mjs`
  第 4 条「views 零 `data/store` import」（有牙：造一个带 import 的 view 当场 FAIL）。
- 验证：typecheck + 132 单测 + color-scan + api-scan + build + browser-smoke（第八/九节
  真拖一条、验顺序变 + 落库 localStorage）全绿。
