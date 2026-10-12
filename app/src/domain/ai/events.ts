/**
 * events.ts —— AI 事件类型定义
 */

/** 与 server/lib/ai/chat.mjs 里 emit 的那些一一对应 */
export interface AiUsage {
  input: number;
  output: number;
  totalTokens: number;
}

/**
 * 一张待确认的改动卡片。
 *
 * **`fields` 是最终要落进 op 的字段，不是「意图」。** 确认那一步（`POST /api/ai/confirm`）
 * 只认 id，它按 id 从库里把这份东西读回来、重查一遍权限、套上 deviceId='ai' 发出去。
 * 所以界面这边也只需要读 `fields` 就能把「打算改什么」说清楚，不用去猜 kind 的语义。
 *
 * **不要在界面上拿它去算最终结果**（比如自己推一个改完之后的日期）：
 * 真正落库的可能被权限挡下、也可能被 LWW 判给另一边。卡片只描述意图。
 */
export interface AiProposal {
  id: string;
  /** create | update | complete | uncomplete | reschedule | delete */
  kind: string;
  calId: string;
  calName?: string;
  entity: string;
  entityId: string;
  title: string;
  fields: Record<string, unknown>;
}

export type AiEvent =
  | { type: 'session'; sessionId: string; isNew?: boolean }
  | { type: 'text'; delta: string }
  | {
      type: 'tool'; phase: 'start' | 'end'; name: string;
      args?: Record<string, unknown>; isError?: boolean; summary?: string;
    }
  | { type: 'proposal'; proposal: AiProposal }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; sessionId?: string; usage?: AiUsage | null };

/** `POST /api/ai/confirm` 里确认成功的那几条 —— 只在 toast 里用来报数 */
export interface AiConfirmed {
  id: string;
  kind: string;
  calId: string;
  entityId: string;
  title: string;
}

/**
 * 服务器已经落库的一条消息（GET /api/ai/sessions/:id 的形状）
 */
export interface AiChatMessage {
  id: string;
  role: string;
  text: string;
  tools: { name: string; args?: unknown }[];
  proposals: AiProposal[] | null;
  createdAt: number;
}

export interface AiSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 服务器上的模型配置形状。**没有 apiKey 字段** —— 服务器只用不回显
 * （`lib/ai/settings.js` 的 `publicShape()`），所以这里也画不出一个不存在的字段。
 */
export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  /** 有没有配 key。没配不一定不能用 —— 本机那种网关就不需要 */
  hasKey: boolean;
  /** Base URL 和模型名都填了 */
  ready: boolean;
}

/**
 * 改配置时提交的内容。**`apiKey` 不传 = 保留原值，传空串 = 清空。**
 * 这个区分必须保住：设置浮层每次打开都读不到原 key，所以它提交时只能
 * 「用户真的改了 key 才带上这个字段」，否则一打开一保存就把 key 抹了。
 */
export interface AiSettingsPatch {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/* ============================== 记忆 ============================== */

export interface AiMemory {
  id: string;
  type: string;   // preference | decision | pattern
  content: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/* ============================== 操作历史 ============================== */

export interface AiHistoryItem {
  seq: number;
  calId: string;
  calName: string | null;
  entity: string;
  entityId: string;
  field: string;
  value: string | null;
  ts: number;
  deviceId: string;
  isAi: boolean;
}

/* ============================== 授权 ============================== */

export interface AiAuthorizations {
  taskCrud: string;       // free | confirm
  habitCheckin: string;   // free | confirm
  calendarMgmt: string;   // free | confirm
  eveningReportEnabled: boolean;
  eveningReportTime: string;
  updatedAt: number | null;
}
