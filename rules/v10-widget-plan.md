# 第 10 册 · Android 桌面小组件 — 违规清单与实施

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`v10-widget-rules.md`](v10-widget-rules.md)。
> 不变量：**外部 import 路径一律不变**；小组件只约束 Android 桌面；网页与小组件共享同一权威数据。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

<|end|> 位置 | 现象 | 归属 |
|---|---|---|
| `app/android/.../ScheduleWidgetProvider.kt` | 判据 1 未验：快照字段与 `widgetSnapshot.ts` 是否完全对齐 | 待审 |
| `WidgetData.kt` | 缺 `lastSyncAt` 字段（Freshness 无法判断） | 待补 |
| `RepeatSpawn.kt` | spawn 逻辑是否已迁到 `repeatNext` 级联 | 待验 |

## 2. verify（暂无，待 Implementation）

---

## 3. 扫描方案

<|channel|> 规则 | 怎么扫 |
|---|---|
| §3 共享语义 | `grep` 快照字段在 Kotlin 与 TS 两边对齐 |
| §4 允许例外 | 新增视图差异前在 plan 里登记 |
