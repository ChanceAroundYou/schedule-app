/**
 * people.ts —— 「这个人该显示成什么」的唯一口径（纯逻辑，零 React / DOM / 网络）
 *
 * 昵称优先，没昵称回落到用户名 —— 全站只这一处判这条，别在界面里散落
 * `u.nickname || u.name`：那种散落的写法每处都可能漏掉 trim、漏掉空串。
 */

import type { CalColorKey } from './types/Cal.ts';
import { DEFAULT_CAL_COLOR } from './types/Cal.ts';

export interface Person {
  name: string;
  nickname?: string | null;
}

/** 优先昵称；昵称是空串 / 全空白也当没有 */
export function displayName(u: Person | null | undefined): string {
  const nk = typeof u?.nickname === 'string' ? u.nickname.trim() : '';
  if (nk) return nk;
  return u?.name ?? '';
}

/**
 * 来源 tag 里那一个字符。
 *
 * 取**码点**首字而不是 `charAt(0)` —— 中文没有代理对问题，但 emoji 昵称
 * （`😀旅行`）用 charAt 会切出半个代理对，屏幕上是个乱码方块。
 */
export function initialOf(u: Person | null | undefined): string {
  const name = displayName(u);
  if (!name) return '?';
  const first = Array.from(name)[0];
  return first.toUpperCase();
}

/**
 * 集 → 颜色。
 *
 * `overrides` 是**当前用户自己的**本地显示色（2026-11-09：颜色不是创建者设给
 * 全员的集属性，只是「我看着是什么色」）。有覆盖先读覆盖，没覆盖才读集上那份
 * 默认值，最后回落 DEFAULT。任务卡、圆点、月视图小格都走这一处，不会各画各的。
 */
export function colorOf(
  cals: readonly { id: string; color?: CalColorKey }[],
  calId: string,
  overrides?: Record<string, CalColorKey> | null,
): CalColorKey {
  const own = overrides?.[calId];
  if (own) return own;
  return cals.find((c) => c.id === calId)?.color ?? DEFAULT_CAL_COLOR;
}

/**
 * 日程集的创建者该显示成什么名字。**昵称优先**，查不到再退到缓存里的自己，
 * 再查不到就返回空串（不显示「我建的」「创建者」这类角色词）。
 */
export function ownerDisplayName(
  users: Record<string, Person> | undefined,
  ownerId: string,
  fallback?: Person | null,
): string {
  return displayName(users?.[ownerId]) || displayName(fallback) || '';
}

/** AI 落库时写进 `createdBy` 的固定值（见 `server/lib/sync.js`）。它不是「别人」 */
export const AI_ACTOR = 'ai';

/**
 * 这条任务的来源 tag 该画什么。`null` = 不画。
 *
 * 不画的四种情况：没有 `createdBy`（老数据）、是我自己建的、是 AI 代我建的、
 * **不知道我是谁**（离线 / 未登录 / 首次同步还没落 `meId`）。
 * 最后一条是刻意的：判据是「非**自己**添加」，不知道我是谁就等于这道题没有答案 ——
 * 宁可少画一枚，也不把自己的任务标成别人的（那会把「谁干的」这套认知整个带偏）。
 *
 * 查不到名字（这个人刚被移出我的集、或目录还没刷到）照画，字符是「?」——
 * 「有别人参与但叫不出名字」比「假装没有别人」诚实。
 */
export function creatorOf(
  users: Record<string, Person> | undefined,
  createdBy: string | null | undefined,
  meId: string | null,
): { initial: string; title: string } | null {
  if (!createdBy || !meId || createdBy === meId || createdBy === AI_ACTOR) return null;
  const p = users?.[createdBy];
  return { initial: initialOf(p), title: p ? displayName(p) : '不认识的成员' };
}
