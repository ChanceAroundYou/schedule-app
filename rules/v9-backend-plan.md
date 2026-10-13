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

| 位置 | 现象 | 归则 | 结论 |
|---|---|---|---|
| `routes/cals.js:30,33,51,52,66-70` | 集成员/邀请接口把 `ctx.body.x` 直接递进业务层，路由层未校验类型/长度/控制字符 | B7 | 补路由层校验 |
| `routes/ai.js:40,103,119,138` | AI settings / confirm / memory / authorizations 的 body 直接转交，非整包类型校验 | B7 | 业务层已偶校验，路由层补 |
| `lib/sync.js:111-135` | 单条 op 校验失败 / 字段超限 `continue`，需确认每处都可观测（Rejected 有回报） | B8 | 现有实现已回报，规则锁死 |
| `server.js` | **无 `uncaughtException` / `unhandledRejection` 处理器**（只有 SIGTERM/SIGINT） | B9 | 补兜底，或审 async 边界 |
| `routes/ai.js:79-82`、`lib/ai/confirm.js:108-113` | AI 异常整对象/堆栈 `console.error`，异常内容边界未逐条审视 | B9 | 审视后收敛打印字段 |
| `lib/db/schema.js:19-28` | `ai_settings.api_key` 明文落库（设计如此） | B10 | 规则锁死 + 查数据目录权限 |
| `routes/cals.js`、`routes/sync.js`、`routes/ai.js` 后半 | 集 CRUD / 成员 / 邀请响应 / 同步 / AI 设置未接限流 | — | **本册不立规则**（YAGNI：个人自用部署，过度限流徒增噪音），记录留档 |

### 2. 实施顺序

无必修项。若要动，按这个次序（每步独立可验证）：

1. **B9 进程兜底** —— 影响面最大且零业务风险：`unhandledRejection` 至少打日志。
2. **B7 路由层校验** —— `cals.js` 的集成员/邀请四条路径，照 `sync.js` 的逐字段校验照抄。
3. **B9 日志收敛** —— AI 异常改打 `e.message`（router 已有先例：`115-117` 注释说明不打印 stack）。
4. **B10 目录权限** —— 查 `server/data/` 与备份文件的实际权限位。

### 3. 扫描器方案

| 规则 | 怎么扫 | 放哪 |
|---|---|---|
| B6 | `rg '\$\{' server/lib/db/` 逐点看括号里是不是 `map(()=>'?')` 或常量 | review checklist |
| B7 | 新路由加进 `protocol-scan.mjs`（若已有则扩展）：`ctx.body.` 后未跟 `String()`/`typeof` 报警 | 待建 |
| B9 | `rg 'console\.(log\|error)' server/ -- -A1` 看关键字 | review checklist |
| B10 | `rg 'api_key' server/ -g '!*.db'` 确认只在 `settings.js` 的 `hasKey` 形状出现 | review checklist |
