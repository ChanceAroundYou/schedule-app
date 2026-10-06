/**
 * ai.ts —— AI 对话里那些**可以脱离浏览器测**的部分
 *
 * 一条线划得很清楚：
 *
 *   domain/ai.ts  纯逻辑。SSE 行怎么切、工具调用怎么翻译成人话、
 *                 该往服务器带什么上下文。零 React / DOM / 网络。
 *   ui/aiClient.ts  fetch + ReadableStream。真发请求、真读流。
 *
 * 之所以要把「切 SSE」拆出来，是因为它最容易写错又最难手工验：
 * 网络把一个事件切在两个 chunk 中间是常态，边界处理错一格就丢事件，
 * 而现象只是「偶尔少一句话」。
 */

import type { LocalState } from './types.ts';
import * as D from './date.ts';

/* ============================== 事件形状 ============================== */

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
 * 服务器已经落库的一条消息（GET /api/ai/sessions/:id 的形状） */
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

/* ============================== SSE 解析 ============================== */

/**
 * 从缓冲区里切出**已经完整**的事件，返回剩下没切完的那截。
 *
 * 调用方负责把剩下的那截留到下一个 chunk 前面 —— 这是这个函数唯一的契约，
 * 也是最容易漏的一步：不留 rest 就是「每个 chunk 边界上丢一个事件」。
 *
 * 规则按 SSE 规范来，但只实现用得到的部分：
 *   - 一条消息以**空行**结束（这里只认 `\n\n`；服务器不会发 `\r\n`）
 *   - `data:` 行可以有任意多行，拼接时中间补 `\n`
 *   - `:` 开头是注释行，忽略
 *   - 别的字段（`event:` / `id:` / `retry:`）不用，忽略掉
 *
 * **坏行只丢那一条，不抛。** 服务端多打一行日志、或者 JSON 里有个
 * 半截的中文，都不该让整轮对话当场断掉 —— 那比少一句话难查得多。
 */
export function sseFeed(buf: string): { events: AiEvent[]; rest: string } {
  const events: AiEvent[] = [];
  let rest = buf;

  for (;;) {
    const at = rest.indexOf('\n\n');
    if (at < 0) break;
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);

    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      // 规范说冒号后面那**一个**空格要去掉，多余的空格属于数据本身
      data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;

    try {
      const ev = JSON.parse(data.join('\n')) as AiEvent;
      if (ev && typeof ev.type === 'string') events.push(ev);
    } catch (_) { /* 坏事件跳过，别把整条流带走 */ }
  }

  return { events, rest };
}

/* ============================ 工具调用 → 人话 ============================ */

const fmtRange = (a: unknown, b: unknown): string => {
  if (typeof a !== 'string' || !a) return '';
  if (typeof b !== 'string' || !b || a === b) return D.fmtMD(a);
  return `${D.fmtMD(a)}–${D.fmtMD(b)}`;
};

/**
 * 界面上的动作条文案（「正在查 10月7日的安排」）。
 *
 * **要写死在这里，不能让模型自己说。** 动作条是给用户看的确定性提示，
 * 模型在同一轮里还没开始说话，这里没有它的输出可用。
 *
 * 认不出的工具名原样显示 —— 后端加了新工具而前端还没跟上时，
 * 冒出一个英文工具名也比冒出一个空白条强。
 */
export function actionText(name: string, args?: Record<string, unknown>): string {
  const a = args || {};
  switch (name) {
    case 'list_calendars':
      return '看你的日程集';
    case 'list_tasks': {
      const r = fmtRange(a.from, a.to);
      return r ? `查 ${r} 的安排` : '查安排';
    }
    case 'search_tasks':
      return typeof a.query === 'string' && a.query ? `搜「${a.query}」` : '搜任务';
    case 'load_summary': {
      const r = fmtRange(a.from, a.to);
      return r ? `算 ${r} 的忙闲` : '算忙闲';
    }
    case 'free_slots': {
      const r = fmtRange(a.from, a.to);
      return r ? `找 ${r} 的空档` : '找空档';
    }

    // 写入类的。它们的 args 是模型想改的东西，措辞用「建 / 改 / 挪」这些
    // 还没发生的动词 —— 说成「建好了」会让人以为点不点确认都一样
    case 'create_task':
      return typeof a.title === 'string' && a.title ? `建「${a.title}」` : '建一条任务';
    case 'update_task':
      return '改一条任务';
    case 'complete_task':
      return a.done ? '标完成' : '改回没做';
    case 'reschedule_task':
      return '改期';
    case 'delete_task':
      return '删一条任务';

    default:
      return name;
  }
}

/* =========================== 提案 → 人话 =========================== */

/** 字段名的中文。只列界面上画得出来的那几个 */
const FIELD_CN: Record<string, string> = {
  title: '标题',
  note: '备注',
  date: '日期',
  time: '时间',
  duration: '时长',
};

/**
 * 这些字段是实现细节，卡片上不显示。
 *
 * `order` 会被顺手清掉（换日期时），`trashFrom` 是垃圾箱那行的来源说明 ——
 * 把它们印出来只会让用户看见「位次 → 空」「来源 → AI」这种看不懂的行。
 */
const HIDDEN = new Set(['order', 'trashFrom', 'doneAt', 'createdAt', 'source', 'done']);

/** 「10月8日 14:00」/「10月8日（不定时）」/「14:00」/ '' */
function describeWhen(date: unknown, time: unknown): string {
  const d = typeof date === 'string' && date ? D.fmtMD(date) : '';
  const t = typeof time === 'string' && time ? time : '';
  if (d && t) return `${d} ${t}`;
  if (d) return `${d}（不定时）`;
  if (t) return t;
  return '';
}

/** `update` 那种部分改动的「改了什么」列表 */
function changeList(f: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (HIDDEN.has(k) || !FIELD_CN[k]) continue;
    if (k === 'date') out.push(`日期 → ${v ? D.fmtMD(String(v)) : '待办箱'}`);
    else if (k === 'time') out.push(`时间 → ${v ? String(v) : '不定时'}`);
    else if (k === 'duration') out.push(`时长 → ${D.fmtDuration(Number(v))}`);
    else out.push(`${FIELD_CN[k]} → ${String(v).slice(0, 40)}`);
  }
  return out.length ? ' · ' + out.join('，') : '';
}

/**
 * 卡片标题：这次打算改什么。
 *
 * 说成**还没发生**的事（「新建」「改期」「删掉」），因为确认之前它确实没发生 ——
 * 文案写成「已建好」而用户没点确认，他会以为任务已经在了。
 */
export function proposalText(p: AiProposal): string {
  const f = p.fields || {};
  const title = p.title || '这条任务';
  switch (p.kind) {
    case 'create': {
      const when = describeWhen(f.date, f.time);
      return `新建「${title}」${when ? ' · ' + when : ''}`;
    }
    case 'update':
      return `改「${title}」${changeList(f)}`;
    case 'complete':
      return `把「${title}」标成做完`;
    case 'uncomplete':
      return `把「${title}」改回没做`;
    case 'reschedule': {
      const when = describeWhen(f.date, f.time);
      return `「${title}」改期${when ? '到 ' + when : ''}`;
    }
    case 'delete':
      return `删掉「${title}」（会进垃圾箱）`;
    default:
      return title;
  }
}

/* ============================== 上下文 ============================== */

/**
 * 告诉服务器「我正在看什么」。
 *
 * 这几样服务器**不知道**：它没有界面的概念。但模型需要它们才答得准 ——
 * 用户问「这周呢」，得知道「这周」是从哪一天算起的。
 *
 * 只带 id 和名字这类小东西，**不带任务内容**：内容模型自己会用工具查，
 * 而快照是随每次请求传的，塞进去只会让每条消息都拖着一份全量数据。
 */
export function buildContext(s: LocalState): Record<string, unknown> {
  const cal = s.cals.find((c) => c.id === s.ui.cal);
  const out: Record<string, unknown> = {
    today: D.today(),
    nav: s.ui.nav,
    view: s.ui.view,
    cursor: s.ui.cursor,
  };
  if (cal) { out.calId = cal.id; out.calName = cal.name; }
  return out;
}

/* ============================== 消息拼装 ============================== */

/**
 * 流式过程中的一条助手气泡。`text` 是**逐字追加**出来的，所以界面拿它
 * 当 key 时要用稳定的 id，不能用下标。
 */
export interface LiveAssistant {
  id: string;
  text: string;
  /** 这一轮调过的工具，动作条用 */
  actions: { name: string; label: string; done: boolean; error?: boolean }[];
  /** 这一轮产生的待确认改动，卡片用。顺序就是模型想改的顺序 */
  proposals: AiProposal[];
  error?: string;
}

export function newLiveAssistant(id: string): LiveAssistant {
  return { id, text: '', actions: [], proposals: [] };
}

/** 把一个流事件并进当前这条助手气泡。返回新的对象（React 要新引用才重渲染） */
export function applyEvent(live: LiveAssistant, ev: AiEvent): LiveAssistant {
  switch (ev.type) {
    case 'text':
      return { ...live, text: live.text + ev.delta };

    case 'proposal': {
      // 按 id 去重。正常一轮里每条只会来一次，但流被重放 / 重连时不该冒出两张
      // 一样的卡片 —— 那样用户会以为有两处改动、确认两遍
      if (live.proposals.some((p) => p.id === ev.proposal.id)) return live;
      return { ...live, proposals: [...live.proposals, ev.proposal] };
    }

    case 'tool': {
      const label = actionText(ev.name, ev.args);
      if (ev.phase === 'start') {
        return { ...live, actions: [...live.actions, { name: ev.name, label, done: false }] };
      }
      // 结束：把最后一条同名且未完成的标成完成 —— 不按下标配对，
      // 因为同一个工具一轮里可能被调两次（模型经常这么干）
      const actions = live.actions.slice();
      for (let i = actions.length - 1; i >= 0; i -= 1) {
        if (actions[i].name === ev.name && !actions[i].done) {
          actions[i] = { ...actions[i], done: true, error: !!ev.isError };
          break;
        }
      }
      return { ...live, actions };
    }
    case 'error':
      return { ...live, error: ev.message };
    default:
      return live;
  }
}
