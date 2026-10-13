# 第 3 册 · 命名 — 违规清单与实施

> 状态：**待审核**（实施计划，分期完成）
> **规则见** [`v3-naming-rules.md`](v3-naming-rules.md)。
> 不变量：**本册只定名字，不改任何导出**。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

| 位置 | 现象 | 归属 |
|---|---|---|
| `ui/kit/Dropdown.tsx:53` | `className/menuClassName` 对外透传 | 第 1 册 S4 修 |
| `ui/settings/SettingsView.tsx:120` | `rounded-full` 写死圆角 | 第 1 册附录（`--r-pill` 替换） |
| `--panel-2/--text-2` 类序号 | 同角色深浅档，**允许保留**，不算违规 | — |
