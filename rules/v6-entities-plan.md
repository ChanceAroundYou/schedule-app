# 第 6 册 · 数据实体与行为 — 违规清单与实施

> 状态：**待审核**（实施计划，分期完成）
> **规则见** [`v6-entities-rules.md`](v6-entities-rules.md)。
> 不变量：字段清单以 `domain/types/*` + `docs/业务模型.md` 为准，**本册不重写字段，只定行为归属**。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

| 位置 | 现象 | 结论 |
|---|---|---|
| `hydrateTask` 50 行 | 12 个并列 if | 第 4 册 F1 特许形态，留 |
| `SyncResponse.snapshot.projects?` 可选 | 老响应落新客户端不炸 | E2 先例，留（新实体照抄） |
| `overlays.css .check-circle border:#fff` 写死 | 白勾压浅绿 `--primary` 对比度 ~2:1 | 真 bug，属颜色，待第 8 册或单修（重构 spec 附录 A 已记） |
