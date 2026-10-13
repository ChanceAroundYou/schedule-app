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
| `views/` 受控 `Input onChange` ×N | 打字本地态，无 store 调用 | D2 特许，留 |
| `Dropdown` 内部手写 `<button>` ×2 | 该走 `Btn` | 第 1 册 S4 修 |
| `Sheet --kb` 兜底 | 运行时变量真默认值 | 第 3 册 N3 白名单，留 |
| `views/` 5 处 import `reorder`/`reorderList`（`data/store/sort.ts`，走 `commitMany`）：`Habits` + `lists/{Inbox,Today,Overdue,Done}` | **D1 破**：views 引了 `data/store` 写入口（拖拽排序） | ⏸ 挂起，见下 |

**D1 那条（5 处 `reorder`/`reorderList`）为什么挂起不修**：

- **写门没绕过**：`reorder → commitMany → canWrite(roleOf)`，权限把关照走，不是安全洞，
  纯粹是「views 不碰 `data/`」的分层破口。
- **修起来和「views 零回调」顶牛**：dnd 的 `onReorder` 是个**回调**，不是可委托的
  `data-act` 点击。`SortableList`（`ui/kit`）要它，而 views 又不许从 App 收 `onX` props
  （D2.1）—— 这个回调**没有干净的下行路径**。把 5 处挪出 views 得先解决「dnd 回调从
  哪来」，那是设计改动，不是搬代码。
- **动的是踩坑 6/12 的 dnd 线**，风险配不上「分层更纯」这点收益。
- 所以两条出路二选一，**都不在本册范围**：① 给 D1 加一条「dnd 排序回调（`reorder`/
  `reorderList`）」的**显式豁免**（承认它是 dnd 的固有回调，不是普通写入口）；② 等哪天
  重做 dnd 回调流时一并修。当前**先记着，不假装合规**。
- 扫描器不锁这条：`api-scan.mjs` 若加「views 零 `data/store` import」会当场红（5 处已破），
  和第一册 ratchet 一个道理——**代码不合规时锁不了**。等上面二选一落地再补锁。
