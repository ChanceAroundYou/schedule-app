/**
 * parse.ts —— 自然语言解析主函数
 */

import * as D from '../date.ts';
import type { RepeatRule } from '../types/types.ts';
import { rulesOf } from './rules.ts';

export interface ParseOut {
  title: string;
  date: string | null;
  time: string | null;
  duration: number | null;
  repeat: RepeatRule | null;
  chips: string[];
}

export interface Rule {
  re: RegExp;
  fn: (o: ParseOut, m: RegExpExecArray, ctx: Ctx) => string | null;
}

interface Ctx {
  leftOk: boolean;
  rightOk: boolean;
  isolated: boolean;
  beforeNum: boolean;
}

/**
 * 逐条规则扫一遍。
 *
 * 不用 String.replace 是因为拿不到「匹配位置对应的原始串」的类型化写法；
 * 这里手写扫描，语义与 replace 完全一致（从左到右、不重叠、上下文取自本轮输入）。
 */
function applyRule(rule: Rule, src: string, o: ParseOut): string {
  const re = new RegExp(rule.re.source, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const full = m[0];

    // 零长匹配会让 lastIndex 原地不动 → 死循环。现有规则不会产生，
    // 但规则是可扩展的，这里兜一手。
    if (full === '') {
      out += src.slice(last, m.index + 1);
      last = m.index + 1;
      re.lastIndex = m.index + 1;
      continue;
    }

    const offset = m.index;
    const before = src.slice(0, offset);
    const after = src.slice(offset + full.length);
    const leftOk = offset === 0 || /\s$/.test(before);
    const rightOk = offset + full.length === src.length || /^\s/.test(after);

    const ctx: Ctx = {
      leftOk,
      rightOk,
      isolated: leftOk && rightOk,
      beforeNum: /[0-9/.\-]$/.test(before),
    };

    const label = rule.fn(o, m, ctx);
    out += src.slice(last, offset);
    out += label ? ' ' : full;
    if (label) o.chips.push(String(label));
    last = offset + full.length;
  }

  out += src.slice(last);
  return out;
}

/** 解析入口。解析不出任何东西时 title 回退成原文。 */
export function parse(input: string, todayIso?: string): ParseOut | null {
  const base = todayIso || D.today();
  const text = String(input || '').trim();
  if (!text) return null;

  const o: ParseOut = { title: '', date: null, time: null, duration: null, repeat: null, chips: [] };

  let s = text;
  for (const rule of rulesOf(base)) s = applyRule(rule, s, o);

  o.title = s
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，,。.、；;：:\-\s]+/, '')
    .replace(/[，,。.、；;：:\-\s]+$/, '')
    .trim();
  if (!o.title) o.title = text;
  o.chips = o.chips.filter(Boolean);
  return o;
}
