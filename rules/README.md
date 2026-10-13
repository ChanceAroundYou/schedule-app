# 项目编码规范 · 总纲

> 状态：**待审核**（9 册规则已写，实施未开始）
> 目录：`rules/`（仓库顶层，本目录）
> 不变量：**外部 import 路径一律不变**；`domain/` 保持零 React / DOM / 网络；
> 后端只引 AI 那组依赖（见第 9 册 B5），其余 Node 标准库。

---

## 为什么立这套规范

散规现状：800 行 / 50 行 / 嵌套 4 层出自全局 `security-review.md`；
命名、令牌、变量名散在 `CLAUDE.md` + `docs/界面约定*.md`；
六条数据不变量散在 `CLAUDE.md`「二、不变量」+ `docs/业务模型.md`；
数据流（`domain→data→views` 单向、`views/` 零回调）散在 `CLAUDE.md`「一、结构」+ `docs/重构路线*.md`；
测试三层散在 `docs/测试.md`。
**本规范只做一件事：把散规收成册，给每条配判据和扫描器。**

---

## 规则与计划分离

每册拆成两个文件，**分开读、分开改**：

| 文件 | 是什么 | 什么时候动它 |
|---|---|---|
| `*-rules.md` | **长期遵守的规矩** + 现状审计 + 判据 | 新增行为要查「归哪册哪条」；规则本身很少改 |
| `*-plan.md` | 违规清单 + 实施顺序（分期） | 排期开工时；修完一条删一条 |

规则是**承诺**（不许破），计划是**进度**（会变完）。混在一起读会导致「改规矩」和「修代码」互相干扰。

---

## 分册目录（9 册）

规则文件统一带「依据 / 不变量」头 + `现状审计 → 规矩 → 判据` 三段。
第 7 册（测试）验证命令属纪律，合并在 rules 内，无独立 plan。

| 册 | 管什么 | 规则 | 计划 |
|---|---|---|---|
| **1. 组件 API** | props 封闭、cva 变体、派生、布局外层管 | `v1-component-api-rules.md` | `v1-component-api-plan.md` |
| **2. 样式归属** | CSS 放哪、三层边界、状态类白名单 | 并入第 1 册（R1–R5） | 并入第 1 册 |
| **3. 命名** | 变量 / 文件 / 组件 / 类名 / CSS 变量 | `v3-naming-rules.md` | `v3-naming-plan.md` |
| **4. 文件与目录** | 长度上限、文件夹划分、粒度、barrel | `v4-file-layout-rules.md` | `v4-file-layout-plan.md` |
| **5. 分层与数据流** | `domain→data→views` 单向、零回调、委托 | `v5-dataflow-rules.md` | `v5-dataflow-plan.md` |
| **6. 数据实体与行为** | 六道口子、零迁移、派生与本地性 | `v6-entities-rules.md` | `v6-entities-plan.md` |
| **7. 测试** | 三层测试、扫描器矩阵、隔离收尾 | `v7-testing-rules.md` | —（纪律式，无 plan） |
| **8. 交互与无障碍** | a11y、浮层、键盘、动效、文案 | `v8-a11y-rules.md` | `v8-a11y-plan.md` |
| **9. 后端接口** | 路由、鉴权、同步、AI 三段、SQL 绑定、校验分层、日志 | `v9-backend-rules.md` | `v9-backend-plan.md` |

### 每册判据（怎么判成没成）

| 册 | 判据 |
|---|---|
| 1+2 | 每个 kit 组件 props 有清单、无 `className` 透传；调用方零 Tailwind 外观类；一个类名只有一个宿主 |
| 3 | 令牌名写错当场可见（无兜底值，`contrast.mjs` 锁）；文件名 = 导出名；CSS 变量按角色不按序号 |
| 4 | 最长文件 313 行（AiPanel），远低于 800 上限；拆分只用 barrel 模式，外部 import 路径不变 |
| 5 | `domain/` 零 React/DOM/网络（已验纯净）；`views/` 零 `onX` props（已验 0 处）；写操作只走委托 + 两道把关 |
| 6 | 构造走 `make*`；外部数据必过 `hydrate*`；可见性只认 `isGone`/`isTrashed`；缺字段按旧行为处理 |
| 7 | `npm test` + `browser-smoke.mjs`（400+ 断言）+ 4 个扫描器全绿；跑完收干净 |
| 8 | 每个控件有可访问名字（placeholder 不算）；浮层四件套齐；动效全站关；探针断言锁 |
| 9 | 读走 `snapshot`、写走 `applyOps`；`confirm` 只信 id 不信参数；权限只在三入口；SQL 值必绑定、异常不泄敏感 |

---

## 现状快照（写总纲时的实测，供各册开工对照）

- 最长文件：`AiPanel.tsx` 313 行 → 800 上限**无压力**
- `domain/` 纯度：**已验纯净**（零 React/DOM/网络 import）
- `views/` 回调：**已验 0 处** `onX` props
- server 文件：最长 `calendars.js` 228 行，`server/data/` gitignored
- 全套验证（开工前基线）：typecheck ✓、单元 0 fail ✓、color-scan ✓、contrast 全绿 ✓、browser-smoke 全绿 ✓

---

## 建议实施顺序

1 → 3 → 4 → 5 → 6 → 8 → 9 → 7。

理由：1（组件封闭）是其余各册的载体——组件不封闭，样式和 props 规矩无处安放；
3、4 是静态规则，好写好锁；5、6、8、9 涉及运行时不变量，要动探针；7 收尾时把扫描器编成矩阵。
每步的独立验证命令在 `v7-testing-rules.md` §4 和各册 plan 内。

---

## 与现有文档的关系

- `CLAUDE.md` 仍是入口（往哪走 + 不变量一句话版），**不删不改**
- `docs/业务模型.md` / `界面约定*.md` / `踩坑*.md` 仍是推导和失败症状的出处，**编号稳定引用，别改**
- 本规范只收「不许破的那一句」+ 判据 + 扫描器；推导过程仍链回原文档
- 旧的 `docs/superpowers/specs/2026-10-13-*-spec.md` 已重组为本目录的 rules/plan 对，**spec 路径不要再引用**
