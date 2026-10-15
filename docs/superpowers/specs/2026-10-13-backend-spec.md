# 编码规范第 9 册 · 后端接口

> 状态：**待审核**（spec 已产出，实现未开始）
> 依据：`server/routes/*`（auth/cals/sync/ai 四组）、`server/lib/sync.js`（Rejected 三态）、
> `server/lib/auth.js`（自签 JWT+jti 吊销）、`server/lib/ai/*`（工具→提案→确认三段）、
> `server/tests/*`、`docs/接口*.md`、`AGENTS.md` 二、AI
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

---

## 3. 判据

1. 新增路由 `rg` 无撞车；REST vs LWW 归属对（关系走 REST，字段走 LWW）。
2. 权限判断三入口外无 `role ===` 比较（`rg` 全仓）。
3. AI 写路径三段不断路：工具无 DB import、confirm 重查权限（review checklist）。
4. 后端 `npm test`（api/migration/ai）全绿；`server/data/` 不在 git 里（`git check-ignore`）。

---

## 4. 违规清单（本册不修，只记）

| 位置 | 现象 | 结论 |
|---|---|---|
| 无 | 本次审计后端无违规 | — |
