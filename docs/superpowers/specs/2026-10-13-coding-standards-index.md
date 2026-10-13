# 项目编码规范 · 总纲

> 状态：**待审核**（目录 + 判据已立，各册内容待填）
> 第一册（组件 API + 样式归属）已写：`docs/superpowers/specs/2026-10-13-component-api-stylesheet-spec.md`
> 不变量：**外部 import 路径一律不变**；`domain/` 保持零 React / DOM / 网络；后端不引任何新依赖。

---

## 为什么立这套规范

散规现状：800 行 / 50 行 / 嵌套 4 层出自全局 `security-review.md`；
命名、令牌、变量名散在 `CLAUDE.md` + `docs/界面约定*.md`；
六条数据不变量散在 `CLAUDE.md`「二、不变量」+ `docs/业务模型.md`；
数据流（`domain→data→views` 单向、`views/` 零回调）散在 `CLAUDE.md`「一、结构」+ `docs/重构路线*.md`；
测试三层散在 `docs/测试.md`。
**本规范只做一件事：把散规收成册，给每条配判据和扫描器。**

---

## 分册目录（9 册）

| 册 | 管什么 | 现状散在哪 | 判据（怎么判成没成） |
|---|---|---|---|
| **1. 组件 API** ✅已写 | props 封闭、cva 变体、派生、布局外层管 | `docs/组件库.md` + 第一册 spec | 每个 kit 组件 props 有清单、无 `className` 透传；调用方零 Tailwind 外观类 |
| **2. 样式归属** ✅已写 | CSS 放哪、三层边界、状态类白名单 | 第一册 spec §1–§5 | 一个类名只有一个宿主；`:global` 只有状态类白名单；`styles/` 只留三份 |
| **3. 命名** ✅已写 | 变量 / 文件 / 组件 / 类名 / CSS 变量怎么起 | `docs/界面约定.md` §变量名与令牌、`CLAUDE.md` 三、令牌三条 | 令牌名写错当场可见（无兜底值，`contrast.mjs` 锁）；文件名 = 导出名；CSS 变量按角色不按序号 |
| **4. 文件与目录** ✅已写 | 文件长度上限、文件夹划分、粒度、barrel 规则 | 全局 `security-review.md`（800/50/4层）+ `docs/重构-组件合并-实施spec.md` §7 | 最长文件 313 行（AiPanel），远低于 800 上限；拆分只用 barrel 模式，外部 import 路径不变 |
| **5. 分层与数据流** ✅已写 | `domain→data→views` 单向、`views/` 零回调判定、委托协议 | `CLAUDE.md` 一、结构 + 二、AI + `docs/重构路线*.md` | `domain/` 零 React/DOM/网络（已验纯净）；`views/` 零 `onX` props（已验 0 处）；写操作只走 `data-act` 委托 + `store.commitMany()` / `sync.applyOps()` 两道把关 |
| **6. 数据实体与行为** ✅已写 | 六道口子（make/hydrate/visibility/model/commit/remote）、可选字段零迁移、派生与本地性、功能归属表 | `docs/业务模型.md` §数据结构 + `domain/types/*` + `domain/model/*` | 构造走 `make*`；外部数据必过 `hydrate*`；可见性只认 `isGone`/`isTrashed`；本地写只走 `commit/commitMany`；缺字段按旧行为处理，不写 migration |
| **7. 测试** ✅已写 | 三层测试、覆盖率、探针、扫描器矩阵 | `docs/测试.md` + `docs/重构-组件合并-实施spec.md` §8–§9 | `npm test`（domain/data/sync）+ `browser-smoke.mjs`（483 断言）+ `color-scan` / `contrast` / `api-scan`（新增）全绿；跑完收干净（`pkill -x chrome`、`ss -ltnp`） |
| **8. 交互与无障碍** ✅已写 | a11y 四条、可访问名字四种写法、命中区 24、浮层四件套、键盘一档微调、说明文字三条、断网说话、只读提示点名集 | `CLAUDE.md` 三、界面硬规则 + `docs/界面约定-无障碍.md` | 每个控件有可访问名字（placeholder 不算）；浮层四件套齐；`prefers-reduced-motion` 全站关（`.animate-spin` 例外）；探针断言锁 |
| **9. 后端接口** ✅已写 | 路由表、鉴权中间件、限流、错误码（`Rejected` 三态）、AI 写路径三段、snapshot/applyOps 复用 | `docs/接口*.md` + `CLAUDE.md` 二、AI + `server/lib` | 读走 `snapshot`、写走 `applyOps`；`confirm` 只信 id 不信参数；权限只在 `db.roleOf()` / `canWrite`；后端只引 AI 那组依赖 |

---

## 现状快照（写总纲时的实测，供各册开工对照）

- 最长文件：`AiPanel.tsx` 313 行 → 800 上限**无压力**
- `domain/` 纯度：**已验纯净**（零 React/DOM/网络 import）
- `views/` 回调：**已验 0 处** `onX` props
- server 文件：最长 `calendars.js` 228 行，`server/data/` gitignored
- 全套验证（第一册开工前）：typecheck ✓、单元 0 fail ✓、color-scan ✓、contrast 72 对 ✓、browser-smoke 全绿 ✓

---

## 填册顺序与模板

一次填一册，按「现状审计 → 规矩 → 判据 → 违规清单」四段写。
第一册已按此模板写成，后续各册照抄结构。

建议顺序：3（命名）→ 4（文件与目录）→ 5（分层与数据流）→ 6（数据实体与行为）→ 8（交互与无障碍）→ 9（后端接口）→ 7（测试）。
理由：3、4 是静态规则，好写好锁；5、6、8、9 涉及运行时不变量，要动探针；7 收尾时把前面各册的扫描器编成矩阵。

---

## 与现有文档的关系

- `CLAUDE.md` 仍是入口（往哪走 + 不变量一句话版），**不删不改**
- `docs/业务模型.md` / `界面约定*.md` / `踩坑*.md` 仍是推导和失败症状的出处，**编号稳定引用，别改**
- 本规范只收「不许破的那一句」+ 判据 + 扫描器；推导过程仍链回原文档
