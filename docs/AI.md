# AI 助手

应用内一个对话面板：模型自己查排期再回答，并且**能提出改动** —— 但改动要用户点确认才落库。

端点实现在 `server/lib/ai/`；模型是**任意 OpenAI 兼容端点**（本机、Ollama、vLLM、各种网关都行），
配置由用户在界面上填、存服务器。

---

## 一、它为什么不是「另一条写入通道」

AI 不新开一条读写路径，而是**复用同步引擎，假装成一台普通设备**：

- 读 → `sync.snapshot(userId)`
- 写 → `sync.applyOps(userId, ops)`
- `deviceId` 固定 `'ai'`

| 复用 | 为什么不能另起一套 |
|---|---|
| 读 `sync.snapshot()` | 它已经按 `calendarIdsFor(userId)` 过滤、已剔墓碑。自己写 SQL 读 `field_state`，权限过滤迟早漏一处 |
| 写 `sync.applyOps()` | `calendars.canWrite(db.roleOf(...))` 在**这个函数里**，是全项目唯一的服务端权限把关点。AI 绕过去 = 只读成员能被 AI 写穿 |
| 落到界面 `engine.syncNow()` | AI 的 op 会写进 `changes` 并带新 `seq`，客户端本来就会拉到，不用给 AI 单做推送通道 |

于是 AI 自然出现在两处已有机制里：客户端拉到的改动 `_dev === 'ai'`；
用户同一轮手改了同一字段时，`findConflicts` 会把 AI 当另一台设备报冲突 ——
**这是诚实的，不要特判掉**。

## 二、写路径：工具 → 提案 → 确认

这是这个功能里最要紧的一条。

1. **写工具（`create_task` 等五个）的 `execute` 正常返回，但只造提案、不落库。**
   `tools.mjs` 存进 `Map<toolCallId, proposal>`，返回成功结果。
   > **不用 pi 的 `beforeToolCall` 拦。** `block` 会产生错误工具结果，模型以为工具坏了反复重试。
   > 真正的强制是**结构性**的 —— 写工具根本没有写的能力。
2. 提案按 **`toolCallId`** 关联到 assistant 消息（**不按执行顺序**：pi 默认并行执行同一轮工具），
   存进 `ai_messages.proposals`，刷新后卡片还在。
3. `POST /api/ai/confirm` 是**唯一真正落库的地方**（`lib/ai/confirm.js`）。
   **只信 id 不信参数**：按 id 从库里读回提案，**重查一遍权限**（生成到确认之间用户可能被降级 /
   被移出），再走 `sync.applyOps`。信客户端回传的 args 等于把权限判断交给浏览器。

**几个具体约定**：

- 确认时的时间戳走 `confirm.js` 的 `nextTs()`（`max(Date.now(), lastTs+1)`）——
  同一毫秒的两条 op 比较键完全相同，后一条会白写。
- 重复任务**拒绝**标完成：推进逻辑在客户端的 `repeatAdvance()` 里，服务端不复制一份。
- 软删除带 `trashFrom: 'AI'`，垃圾箱那行看得出是 AI 干的。
- `lib/ai/confirm.js` 是 **CJS、直接 require**，不走 `ai/index.js` 的惰性 import：
  确认是纯数据库操作，一条都不碰 pi。依赖没装好时，用户最需要的恰恰是把已排好的改动确认掉。
- 界面动作条文案（「正在查 10月7日的安排」）**写死在 `domain/ai.ts`**，不让模型自己说。

## 三、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/ai/settings` | 读配置。**只回 `hasKey: true/false`，绝不回显 key** |
| `PUT` | `/api/ai/settings` | 写配置 |
| `POST` | `/api/ai/chat` | 发一轮对话，**SSE 流式**返回 |
| `POST` | `/api/ai/confirm` | 确认若干条提案 → **真正落库** |
| `GET` | `/api/ai/sessions` | 会话列表（只有 id / 标题 / 时间，不含消息） |
| `GET` | `/api/ai/sessions/:sessionId` | 一个会话的全部消息 + 未决提案 |
| `DELETE` | `/api/ai/sessions/:sessionId` | 删会话 |
| `GET` | `/api/ai/memory` | 记忆库（最多 50 条，满了丢最旧的） |
| `PUT` | `/api/ai/memory/:id` | 改一条记忆 |
| `DELETE` | `/api/ai/memory/:id` | 删一条记忆 |
| `GET` | `/api/ai/history` | 操作历史（AI 动过什么、什么时候） |
| `GET` | `/api/ai/authorizations` | 授权状态（哪些改动免确认） |
| `PUT` | `/api/ai/authorizations` | 改授权 |

`/chat` 与 `/confirm` 走限速（`rl.hitBoth`，按用户记）。`/chat` 一定要限 —— 它烧的是用户自己的额度。

### 授权

```jsonc
// GET 响应。没有行就用默认值（不落库 —— 用户没改过就不该有行）
{ "taskCrud": "free",        // 建 / 改 / 删任务：free = 免确认
  "habitCheckin": "confirm",   // 打卡：confirm = 要确认
  "calendarMgmt": "confirm",   // 建 / 改日程集：confirm = 要确认
  "eveningReportEnabled": 0,   // 晚间复盘开关
  "eveningReportTime": "21:00" }
```

**邀请永远是人工的**，这一档不设 —— 把「谁进我的集」交给模型裁决不是授权能覆盖的事。

### 配置

```jsonc
// GET /api/ai/settings
{ "provider": "openai", "baseUrl": "http://127.0.0.1:25001/v1",
  "model": "claude-sonnet-5.5",
  "hasKey": true,      // 有没有配 key。没配不一定不能用（本机网关就不需要）
  "ready": true }      // Base URL 和模型名都填了
```

> **`apiKey` 是三态**：**不传 = 保留原值，传空串 = 清空，传值 = 覆盖**。
> 设置浮层每次打开都读不到原 key（服务器不回显），提交时只能「用户真的改了才带上这个字段」——
> 一打开就保存不会把 key 抹掉，靠的就是这个三态。
>
> key 明文落在 `schedule.db` 的 `ai_settings` 里，与 `secret.key` 同一级信任
> （靠数据目录的 nginx 404 + 文件权限隔离）。

### 对话

```jsonc
// POST /api/ai/chat
{ "sessionId": "…",          // 省略则新建
  "text": "下周哪天适合出去玩",
  "context": {               // 客户端补的「当前在看什么」，服务器不知道这些
    "today": "2026-10-06", "calId": "…", "nav": "calendar",
    "view": "week", "cursor": "2026-10-08" } }
```

响应是 `text/event-stream`，一行一个事件：`data: {"type":"…", …}`：

| `type` | 载荷 | 前端拿它做什么 |
|---|---|---|
| `session` | `{ sessionId }` | 新会话时记下 id |
| `text` | `{ delta }` | 追加到气泡（逐字） |
| `tool` | `{ phase: 'start'\|'end', name, args, isError, summary }` | 画「正在查 10月7日 的安排」动作条 |
| `proposal` | `{ proposal }` | 画一张待确认卡片 |
| `done` | `{ sessionId, usage }` | 收尾 |
| `error` | `{ message, code }` | 错误条 |

> 用 SSE 而不是 `EventSource`：要 `POST`、要带 `Authorization` 头，而 `EventSource` 两样都做不到 ——
> 前端用手写 `fetch` + `ReadableStream` 读（`app/src/ui/aiClient.ts`），切行纯逻辑在
> `app/src/domain/ai.ts` 的 `sseFeed()`。
>
> **nginx 那条 `^~ /schedule/api/ai/chat` 是必须的**：父块的 `proxy_read_timeout 30s`
> 会让上游静默超过 30 秒的那一轮直接 504。见 [DEPLOY.md](../DEPLOY.md) 的 SSE 一节。

### 确认

```jsonc
// 请求 —— **只有 id，没有一个可写字段**
{ "ids": ["toolu_…", "toolu_…"] }
```

```jsonc
// 响应。逐条独立处理，一条失败不影响别的
{ "done":   [{ "id": "…", "kind": "create", "calId": "…", "entityId": "…", "title": "买菜" }],
  "failed": [{ "id": "…", "reason": "「全家」你现在没有修改权限" }] }
```

> 一次最多 50 条（`MAX_IDS`）。确认掉的提案会从消息里划掉，**重复确认同一条会得到 `failed`
> 「这条提案已经不在了」**——不是错误，是幂等。提案 id 就是模型那次工具调用的 `toolCallId`。

### 记忆 / 历史

```jsonc
// GET /api/ai/memory
{ "items": [ { "id": "…", "type": "fact", "content": "…",
               "createdAt": 1760000000000, "lastUsedAt": null } ] }

// PUT /api/ai/memory/:id
{ "type": "fact", "content": "他怕狗" }

// GET /api/ai/history
{ "items": [
  { "id": "…", "at": 1760000000000, "kind": "create_task",
    "summary": "新建「买菜」", "calId": "…" } ] }
```

> 记忆由模型**主动**调 `save_memory` 存，不由用户手写。上限 50 条，满了丢最旧的 ——
> 不搞压缩替换。取用时把 `last_used_at` 推上去。

---

## 手工演练：两个人共用一个日程集

不需要界面就能走通全流程，方便排查。

```bash
B=https://home.xiaokubao.space/schedule

reg() { curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"name\":\"$1\",\"password\":\"$2\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4; }

TA=$(reg 妈妈 '……')
TB=$(reg 爸爸 '……')

CAL=$(curl -s $B/api/me -H "Authorization: Bearer $TA" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST $B/api/cals/$CAL/invites -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' -d '{"name":"爸爸","role":"editor"}'
curl -s $B/api/invites -H "Authorization: Bearer $TB"
curl -s -X POST $B/api/invites/<inviteId>/accept -H "Authorization: Bearer $TB"
```

之后再 `GET /api/me`，两个人都应该看到这个集。

> **别把密码写进任何文件或脚本。** 上面两行用完 `history -d` 清掉，或从标准输入喂。
