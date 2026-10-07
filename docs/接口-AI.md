# 接口 · AI

> 总览与认证 → [接口.md](接口.md)；日程集 → [接口-日程集.md](接口-日程集.md)；同步 →
> [接口-同步.md](接口-同步.md)。写路径三段（工具 → 提案 → 确认）见 `CLAUDE.md`「二、AI」。

---

## AI

模型是**任意 OpenAI 兼容端点**（本机的、Ollama、vLLM、各种网关都行），
配置由用户在界面上填、存服务器。端点实现在 `server/lib/ai/`，
业务上的约定（AI 是「另一台设备」、提案闸门）见 `CLAUDE.md` 二、AI。

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

`/chat` 与 `/confirm` 走限速（`rl.hitBoth`，按用户记）。`/chat` 一定要限 ——
它烧的是用户自己的额度。

### `GET` / `PUT /api/ai/authorizations`

```jsonc
// GET 响应。没有行就用默认值（不落库 —— 用户没改过就不该有行）
{ "taskCrud": "free",        // 建 / 改 / 删任务：free = 免确认
  "habitCheckin": "confirm",   // 打卡：confirm = 要确认
  "calendarMgmt": "confirm",   // 建 / 改日程集：confirm = 要确认
  "eveningReportEnabled": 0,   // 晚间复盘开关
  "eveningReportTime": "21:00" }
```

> **邀请永远是人工的**，这一档不设 —— 把「谁进我的集」交给模型裁决
> 不是授权能覆盖的事。

### `GET /api/ai/history`

```jsonc
// 响应
{ "items": [
  { "id": "…", "at": 1760000000000, "kind": "create_task",
    "summary": "新建「买菜」", "calId": "…" } ] }
```

### `GET` / `PUT` / `DELETE /api/ai/memory`

```jsonc
// GET 响应
{ "items": [ { "id": "…", "type": "fact", "content": "…",
               "createdAt": 1760000000000, "lastUsedAt": null } ] }

// PUT 请求体
{ "type": "fact", "content": "他怕狗" }
```

> 记忆由模型**主动**调 `save_memory` 存，不由用户手写。上限 50 条，
> 满了丢最旧的 —— 不搞压缩替换。取用时会把 `last_used_at` 推上去。

### `GET` / `PUT /api/ai/settings`

```jsonc
// GET 响应
{ "provider": "openai", "baseUrl": "http://127.0.0.1:25001/v1",
  "model": "claude-sonnet-5.5",
  "hasKey": true,      // 有没有配 key。没配不一定不能用（本机网关就不需要）
  "ready": true }      // Base URL 和模型名都填了
```

```jsonc
// PUT 请求体，三个字段都可选
{ "baseUrl": "…", "model": "…", "apiKey": "…" }
```

> **`apiKey` 是三态**：**不传 = 保留原值，传空串 = 清空，传值 = 覆盖**。
> 设置浮层每次打开都读不到原 key（服务器不回显），所以它提交时只能
> 「用户真的改了 key 才带上这个字段」—— 一打开就保存不会把 key 抹掉，
> 靠的就是这个三态。

> key 明文落在 `schedule.db` 的 `ai_settings` 里，与 `secret.key` 同一级信任
> （靠数据目录的 nginx 404 + 文件权限隔离）。

### `POST /api/ai/chat`

```jsonc
// 请求
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
| `tool` | `{ phase: 'start'\|'end', name, args, isError, summary }` | 画「正在查 10月7日 的安排」那条动作条 |
| `proposal` | `{ proposal }` | 画一张**待确认卡片** |
| `done` | `{ sessionId, usage }` | 收尾 |
| `error` | `{ message, code }` | 错误条 |

> 用 SSE 而不是 `EventSource`：要 `POST`、要带 `Authorization` 头，
> 而 `EventSource` 两样都做不到 —— 前端用手写 `fetch` + `ReadableStream` 读
> （`app/src/ui/aiClient.ts`），切行的纯逻辑在 `app/src/domain/ai.ts` 的 `sseFeed()`。

> **nginx 那条 `^~ /schedule/api/ai/chat` 是必须的**：父块的
> `proxy_read_timeout 30s` 会让上游静默超过 30 秒的那一轮直接 504
> （建块时实测：30.03s 就 504，改 300s 后 35s 正常）。默认开着的
> `proxy_buffering` 也一并关掉 —— 那条在本机量不出差别，是标准写法的预防。
> 见 [DEPLOY-conf.md](../DEPLOY-conf.md) 4.4，那里把「实测过的」和「照惯例写的」分开列了。

### `POST /api/ai/confirm`

```jsonc
// 请求 —— **只有 id，没有一个可写字段**
{ "ids": ["toolu_…", "toolu_…"] }
```

```jsonc
// 响应。逐条独立处理，一条失败不影响别的
{ "done":   [{ "id": "…", "kind": "create", "calId": "…", "entityId": "…", "title": "买菜" }],
  "failed": [{ "id": "…", "reason": "「全家」你现在没有修改权限" }] }
```

**这是 AI 唯一真正写数据的地方。** 三条规矩（理由写在 `server/lib/ai/confirm.js`
的文件头）：

1. **只信 id 不信参数** —— 要写什么一律按 id 从库里把当时存的提案读回来。
   信客户端回传的 args 等于把权限判断交给浏览器。
2. **写之前重查一次权限** —— 提案生成到确认之间可能隔了几分钟，用户可能已经被
   降级成 viewer 或被移出那个集。
3. **写还是走 `sync.applyOps`** —— 那是全项目唯一的服务端写入闸门。
   AI 的 `deviceId` 固定 `'ai'`，所以它的改动会带 `_dev === 'ai'` 出现在客户端，
   也会正常参与逐字段 LWW 的冲突判定。

> 一次最多 50 条（`MAX_IDS`）。确认掉的提案会从消息里划掉，所以**重复确认同一条
> 会得到 `failed`「这条提案已经不在了」**——不是错误，是幂等。
>
> 提案的 id 就是模型那次工具调用的 `toolCallId`。

---

## 手工演练：两个人共用一个日程集

不需要界面就能走通全流程，方便排查。

```bash
B=https://home.xiaokubao.space/schedule

reg() { curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"name\":\"$1\",\"password\":\"$2\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4; }

TA=$(reg 妈妈 '……')
TB=$(reg 爸爸 '……')

# 妈妈拿到自己的集
CAL=$(curl -s $B/api/me -H "Authorization: Bearer $TA" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# 妈妈邀请爸爸（editor）；爸爸先去 /api/invites 拿 inviteId，再 accept
curl -s -X POST $B/api/cals/$CAL/invites -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' -d '{"name":"爸爸","role":"editor"}'
curl -s $B/api/invites -H "Authorization: Bearer $TB"
curl -s -X POST $B/api/invites/<inviteId>/accept -H "Authorization: Bearer $TB"
```

之后再 `GET /api/me`，两个人都应该看到这个集。

> **别把密码写进任何文件或脚本。** 上面这两行是从终端历史里粘的，
> 用完 `history -d` 清掉，或者干脆从标准输入喂。
