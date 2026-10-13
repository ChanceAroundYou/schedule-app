# 第 9 册 · 后端接口 — 违规清单与实施

> 状态：**已定稿**（实施计划，分期完成）
> **规则见** [`v9-backend-rules.md`](v9-backend-rules.md)。
> 不变量：后端只引 AI 那组依赖，其余 Node 标准库；`server/data/` 永不进仓库。

---

## 0. 怎么读本文件

本册规则在同名 `-rules.md`，本文件只放**当前还没修完的违规**。
修完一条删一行；新增违规先判断归哪册，别在别册的 plan 里记。

---
## 1. 违规清单（本册不修，只记）

> 2026-10-13 深度审计（`server/` 生产代码，含 `lib/ai/`）。
> **无 CRITICAL / HIGH** —— SQL 绑定、JWT 验签、密码哈希都已做到位；
> 以下都是"缺兜底 / 覆盖不全"类，按 B6–B10 归册。
> **2026-10-14 复核**：下表原列的 B7/B9 项多数已落地（见 §2 verify），只留真正没做的。

| 位置 | 现象 | 归则 | 结论 |
|---|---|---|---|
| `routes/ai.js:40,119,138` | AI settings / memory / authorizations 的 body 直接转交业务层，路由层无整包类型校验 | B7 | **留**：业务层已逐字段校验（`settings.js` 的 `URL/MODEL/KEY_MAX`、`memory.js`、`authorizations.js`），值全走 `?` 绑定无注入面；路由层再加一层是纵深防御，非漏洞 |
| `lib/db/schema.js:19-28` | `ai_settings.api_key` 明文落库（设计如此） | B10 | 规则锁死 + 查数据目录权限 |
| `routes/cals.js`、`routes/sync.js`、`routes/ai.js` 后半 | 集 CRUD / 成员 / 邀请响应 / 同步 / AI 设置未接限流 | — | **本册不立规则**（YAGNI：个人自用部署，过度限流徒增噪音），记录留档 |

### 2. verify（2026-10-14）

**判据2 破口闭合**：`lib/calendars.js:210`（`leave` 的「最后一个 owner 不能退」不变量）原先
直接写 `role === 'owner'`，是三入口外的散落比较 → 改 `canManage(role)`（`canManage` 定义即
`role === 'owner'`，逐字等价，与第 6 册前端 `Members.tsx`/`cal.ts` 的修法一致）。现在
`server/` 生产代码 `role === 'owner'` 只剩 `canWrite`/`canManage` 两个定义处 + 一处注释。

**原判据清单复核 —— 多数已落地**（2026-10-13 审计后代码已加固，plan 滞后）：

| 原判据项 | 现状 |
|---|---|
| `cals.js` 集成员/邀请路由层校验（B7） | **已做**：`badName`/`badRole`（类型/长度/控制字符，同 `sync.js` 逐字段模式） |
| `server.js` 无 `uncaughtException`/`unhandledRejection`（B9） | **已做**：`server.js:59-60` 两个 handler，只打 `e.message` |
| `ai.js:82` / `confirm.js:113` AI 异常整对象 `console.error`（B9） | **已做**：两处都收敛到 `e.message`（注释「堆栈可能带库文件路径」） |

**七条判据逐条核对（全绿）**：

1. 路由键全仓唯一、REST vs LWW 归属对 —— 本次无新增路由，`routes/index.js` 头有撞车先例，合规。
2. 权限三入口外无 `role ===` —— **已修**（见上），`rg` 全仓只剩定义处 + 注释。
3. AI 三段不断路 —— 写工具（`write.mjs`/`read.mjs`）零 db import；`memory.mjs` 是文件头明写的
   「唯一不需确认的写工具」（不写日程、不进 `changes`）；`confirm.js:92-93` 重查 `db.roleOf`+`canWrite`。
4. 后端测试全绿 + `server/data/` 不在 git —— api/migration/ai/smoke-share 全过，`git check-ignore` 命中。
5. SQL 值一律 `?` 绑定 —— `rg '\$\{'` 逐点：`map(()=>'?')` 占位符 / `SCHEMA_VERSION` / `ALL_TABLES` /
   固定 `where` 字面量，无请求值拼入。
6. 集成员 body 路由层校验后再转交 —— `cals.js` 的 `badName`/`badRole` 已把关。
7. 日志无凭据、异常不整对象 —— `console.*` 无 key/token/password 字面（仅一处测试小节标题），
   AI 异常两处都只打 `e.message`。

### 3. 扫描器方案

| 规则 | 怎么扫 | 放哪 |
|---|---|---|
| B6 | `rg '\$\{' server/lib/db/` 逐点看括号里是不是 `map(()=>'?')` 或常量 | review checklist |
| B7 | 新路由加进 `protocol-scan.mjs`（若已有则扩展）：`ctx.body.` 后未跟 `String()`/`typeof` 报警 | 待建 |
| B9 | `rg 'console\.(log\|error)' server/ -- -A1` 看关键字 | review checklist |
| B10 | `rg 'api_key' server/ -g '!*.db'` 确认只在 `settings.js` 的 `hasKey` 形状出现 | review checklist |
