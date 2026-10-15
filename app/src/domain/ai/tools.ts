/**
 * tools.ts —— 工具调用翻译
 */

import * as D from '../date.ts';
import type { AiProposal } from './events.ts';

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
  note: '详细内容',
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
