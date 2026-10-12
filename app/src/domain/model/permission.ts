/**
 * permission.ts —— 权限判断
 */

import type { LocalState, Role } from '../types/types.ts';

/**
 * 我在某个集里的角色。**权限判断的唯一入口** —— 别在别处写
 * `cal.role === 'owner'`，加一档角色时会漏掉那些散落的比较。
 */
export function roleOf(s: LocalState, calId: string | null | undefined): Role | null {
  if (!calId) return null;
  const c = s.cals.find((x) => x.id === calId);
  return c ? c.role : null;
}

/** 有没有集可写。false = 还没连上服务器（一个集都没同步下来） */
export function hasCals(s: LocalState): boolean { return s.cals.length > 0; }

/**
 * 按集过滤的一批实体。
 *
 * `calId === null` 表示**不过滤** —— 今天 / 逾期 / 待办箱 / 垃圾箱这几个页面
 * 是跨集的（用户既定：清单跨集，日程按集）。要用 `undefined` 表达「选中的集
 * 恰好是 null（还没同步下来）」时，先看 hasCals。
 */
export function inCal<T extends { calId: string }>(list: T[], calId: string | null): T[] {
  return calId === null ? list : list.filter((e) => e.calId === calId);
}
