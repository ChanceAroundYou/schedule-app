# 编码规范第 9 册 · 后端接口

> 状态：**长期规则**（实施另见 `v9-backend-plan.md`）
> 依据：`server/routes/*`（auth/cals/sync/ai 四组）、`server/lib/sync.js`（Rejected 三态）、
> `server/lib/auth.js`（自签 JWT+jti 吊销）、`server/lib/ai/*`（工具→提案→确认三段）、
> `server/tests/*`、`docs/接口*.md`、`CLAUDE.md` 二、AI
> 不变量：后端只引 AI 那组依赖，其余 Node 标准库；`server/data/` 永不进仓库。

---

## 1. 现状审计（实测）

- 路由表：`server/routes/` 四组——auth（健康/注册/登录/登出/改口令/me）、
  cals（集 CRUD + 成员 + 邀请两段式）、sync（`POST /api/sync` 推拉一次）、
  ai（settings/chat/confirm/sessions/memory/history/authorizations）。
  键即 `'METHOD /api/path'`，`router.js` 直接编译正则；同名路由跨组即撞车（见 `routes/index.js` 头）。
- 鉴权：自签 JWT（`lib/auth.js`，零外部依赖）+ jti 吊销表（登出收回）；`/api/me` 回当前用户。
- Rejected 三态（`lib/sync.js:51-53`）：`bad_request`（终态，丢掉报错）/
  `clock`（时钟不对，留着重试）/ `forbidden`（无写权限，终态；不区分"不存在"与"不归你"防枚举）。
- 同步：`changes.seq` 全局单调自增主键；客户端单 `cursor`；服务端先落盘再取数；
  新进集历史在游标后，客户端见陌生 `calId` 即要全量快照。
- AI 三段：写工具 `execute` 只造提案（`Map<toolCallId, proposal>`，`chat.mjs:158`）→
  提案按 `toolCallId` 挂 assistant 消息（并行，不按序，`persist.mjs:25`）→
  `POST /api/ai/confirm` 唯一落库（按 id 读回、重查权限、走 `applyOps`）。
  `confirm.js` 纯 DB、CJS 直接 require，不碰 pi（依赖没装也能确认已排好的改动）。
- AI 复用三件：读 `sync.snapshot(userId)`（已按 `calendarIdsFor` 过滤、已剔墓碑）/
  写 `sync.applyOps(userId, ops)`（唯一服务端把关点，绕过=只读被写穿）/
  落库带新 `seq`（客户端自然拉到，无需推送通道）。
- 后端测试：`server/tests/`（api/migration/ai + `smoke-share.mjs`）。
- SQL 注入面（实测）：生产 SQL 的值一律 `?` 绑定；动态拼接只用于占位符列表
  （`calIds.map(() => '?')`）、固定条件、内部白名单表名（`ALL_TABLES` 常量）。
  未发现把请求值直接拼入 SQL 的位置。
- 输入校验分层：HTTP 层限 `MAX_BODY`（16 MiB）+ 拒非对象；注册/登录/改口令/
  集名/同步 op/AI 正文有明确校验；集成员等接口 body 字段直接转交业务层。
- 限流覆盖：注册/登录/改口令/发邀请/AI chat/AI confirm 接限流；
  集 CRUD/成员/邀请响应/同步/AI 设置等**未接**（键按 IP / 用户名 / 用户 ID）。
- 错误处理：router `try/catch` 兜底，普通错误统一 `{error: string}`；
  **无进程级 `uncaughtException` / `unhandledRejection`**（只有 SIGTERM/SIGINT）。
- 日志：`console.log` / `console.error`，无日志文件；启动信息 + 路由异常 message +
  AI 异常堆栈。未显式打印密码/token/key，但异常对象内容边界未逐条审视。
- 事务：`applyOps` 整批一个 `db.tx`；单条非法 op 拒绝后**继续**处理，
  字段超限静默跳过，其他 SQL 异常使**整个事务回滚**。
- 密码：`crypto.scryptSync` + 随机盐 + `timingSafeEqual`，存 `salt/hash` 不存明文。
- JWT：固定 HS256，验签按固定 HMAC（不按 token 头动态选算法），查 `exp/sub/jti`。
- AI key：**明文落库**（`ai_settings.api_key`），接口只回 `hasKey` 不回显。

---

## 2. 规矩

### B1 路由：键即契约，四组边界

- 路由键 `'METHOD /api/path'` 全仓唯一；新增先 `rg` 查撞车（`routes/index.js` 头有先例）。
- 四组各管：auth（谁+凭据）/ cals（集+成员+邀请，关系型，不走 LWW）/
  sync（字段级 LWW 推拉）/ ai（对话+提案+确认）。
- 集/成员/邀请走普通 REST，不走 LWW（关系不是字段）；LWW 只管任务/打卡/项目字段。

### B2 鉴权与权限：三入口，不枚举

- 权限判断只在 `canWrite/canManage`（前端）/ `db.roleOf()`（服务端）；
  别处不许写 `role === 'owner'`（加档会漏）。
- `forbidden` 不区分"不存在"与"不归你"（防 id 枚举）；`clock` 留着重试并提示改时间；
  `bad_request` 丢掉并报错——三态处理在客户端各走各路，不混。
- 密钥（AI key）只回 `hasKey` 不回显；`PUT` 省略=保留、空串=清空（三态保住）。

### B3 同步：先落盘再取数，单游标

- `POST /api/sync` 一次推拉：服务端先落盘（`applyOps`）再取数（`changes`），顺序不反。
- `seq` 全局单调；客户端单 `cursor`（不按集分）；服务端按 `cal_id IN (我的集)` 过滤。
- 客户端见陌生 `calId` 即要全量快照（增量永远拉不到游标后的历史）。
- 时间戳只拒绝不钳制（钳制值取决于收到时刻，重放钳出两值）；比较键 `(ts, deviceId)` 创建时固定。

### B4 AI：结构性强制，三段不短路

- 写工具无写能力（只造提案）——不用 `beforeToolCall` 拦（block 产错误结果，模型重试）。
- 提案按 `toolCallId` 关联；`confirm` 只信 id 不信参数（防浏览器改 args 提权）；
  确认前**重查权限**（生成到确认间可能被降级/移出）。
- 确认时间戳 `max(Date.now(), lastTs+1)`（同毫秒两 op 比较键相同会白写）；
  重复任务拒绝标完成（推进在客户端）；软删除带 `trashFrom: 'AI'`。
- pi 调用只关 `lib/ai/chat.mjs` 一文件；依赖锁精确版本（没到 1.0）。

### B5 后端依赖与数据目录

- 后端只许 AI 那组依赖（`@earendil-works/pi-agent-core` + `pi-ai`），其余 Node 标准库。
  "零依赖"已于 2026-10-06 被推翻（为接 pi），但**有范围的让步，不是随便引**。
- `server/data/`（SQLite 权威库）gitignored；测试换目录跑（`SCHEDULE_DATA_DIR=/tmp/x`）。
- 不引入 `v1/v2` 版本号并存；不改 nginx 路径结构（无 `/schedule2/`），回滚靠换 `dist/`。

### B6 SQL：动态片段只能来自占位符生成器或固定白名单

- 值一律 `?` 绑定，**不许把请求值拼进 SQL 字符串**。
- 允许的动态拼接只有两种：`arr.map(() => '?')` 生成的占位符列表（`IN (...)`）、
  以及常量白名单（`ALL_TABLES`、`SCHEMA_VERSION`）。两者来源都必须是程序构造。
- 新写 `${}` 进 SQL 前自问：拼进来的是**值**还是**结构**？是值就改成 `?`。

### B7 输入校验：分层，逐路由明确

- HTTP 层管**体积与形状**：`MAX_BODY`（16 MiB）超限 413、非对象/数组 400。
- 路由层管**类型化 + 必填 + 长度 + 控制字符**：`String()` 后校验，别直接把
  `ctx.body.x` 递进业务层当字符串用（review checklist）。
- 业务层管**语义**：集名非空且 ≤40、密码 6–200 且拒纯数字、同步 op 逐字段。
- 校验不通过的早退，别让未校验值走到 SQL 或进程外。

### B8 applyOps 部分失败语义：显式且可复述

- 整批 ops 在一个 `db.tx` 里。单条校验失败 / 无写权限 / 字段超限 → **跳过该条继续**；
  其他 SQL 异常 → **整个事务回滚**。
- 这个"部分失败继续 vs 整体回滚"的边界是契约，改前先弄清为什么这么分
  （逐条拒绝要能回报给客户端是哪条，单条 SQL 崩说明数据坏了不该半途收手）。
- 跳过分支必须**可观测**（Rejected 三态返回给客户端），不许静默 `continue`。

### B9 日志不泄凭据，进程有兜底

- 显式日志（`console.*`）不得打印密码、token、AI key。AI 异常堆栈打印前
  想清楚异常对象里可能带什么上游内容。
- JWT 固定 `HS256`，验签按固定 HMAC 校验（**不读 token 头里的 `alg`**），
  查 `exp` / `sub` / `jti`。漏过期检查或支持 `alg=none` 是 CRITICAL。
- 进程级 `uncaughtException` / `unhandledRejection` **目前没有** —— 现状态下
  一个未 await 的 rejected promise 会静默消失。要么补兜底，要么保证每个
  async 边界都接住；别默认"反正有 router 的 try/catch"（它只包住同步 handler）。

### B10 AI key 明文落库：把它当密钥看待

- `ai_settings.api_key` **明文存库**（设计如此，schema 有注释说明）。接口层
  只回 `hasKey` 布尔值，**任何路径都不回显 key**。
- 因此**数据库泄露 ≈ 第三方 key 泄露**，影响面比"密码哈希被撞"直接得多：
  保护数据目录权限（`server/data/`）、备份文件权限、别把库文件提交/同步出去。
- 别把"hash 存密码"的思路套到 key 上——key 每次调用都要用原文，必须可逆；
  防线在库文件本身，而不在存储形态。

---

## 3. 判据

1. 新增路由 `rg` 无撞车；REST vs LWW 归属对（关系走 REST，字段走 LWW）。
2. 权限判断三入口外无 `role ===` 比较（`rg` 全仓）。
3. AI 写路径三段不断路：工具无 DB import、confirm 重查权限（review checklist）。
4. 后端 `npm test`（api/migration/ai）全绿；`server/data/` 不在 git 里（`git check-ignore`）。
5. SQL 值一律 `?` 绑定；`${}` 只出现占位符生成器（`map(()=>'?')`）或固定常量清单，
   `rg '\$\{' server/lib/db/` 逐点确认来源非请求值。
6. 集成员等 body 字段在路由层校验后再转交（对照 `cals.js` 邀请/成员路径）。
7. 日志无 `key`/`token`/`password` 字面；异常对象不整对象 `console.error`。

---

