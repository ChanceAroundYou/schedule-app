/**
 * creatorOptions.ts —— 日程页「按创建者筛选」的选项表（纯逻辑，零 DOM）
 *
 * ## 为什么选项要从「数据里真实出现过的人」推
 *
 * 只列 `state.users`（我所有集的成员）会多出一堆当前这个集根本没有人的人，
 * 选了之后整张日历空着 —— 用户会以为任务丢了。
 * 只列「这批任务里出现过的人」又会在某人这周还没建任务时找不到 ta，
 * 想「看看他排了什么」就无从下手。
 *
 * 所以两者取并集：**见过的成员 + 建过任务的人**。仍然查不到的人（刚被移出集）
 * 由 `creatorFilterValid()` 收回到「全部成员」，不会停在一个空视图上。
 *
 * AI 算「我」——见 domain/people.ts 的 AI_ACTOR：AI 是代我落库，不是别人。
 */

import type { LocalState } from '../../domain/types.ts';
import { AI_ACTOR, displayName } from '../../domain/people.ts';
import { isGone } from '../../domain/model/visibility.ts';
import { ownerOf } from '../../domain/model/tasks.ts';

export interface CreatorOption {
  value: string;
  label: string;
}

/** 全部选项。第一项恒为「全部成员」，第二项是**我自己的昵称**（不是「我建的」，
 *  用户 2026-11-09：显示人就写名字，别写角色词）。不知道我是谁时不放它。 */
export function creatorOptions(s: LocalState): CreatorOption[] {
  const out: CreatorOption[] = [{ value: 'all', label: '全部成员' }];
  if (s.meId) {
    const mine = displayName(s.users?.[s.meId]);
    out.push({ value: 'me', label: mine || '我' });
  }

  const ids = new Set<string>();
  for (const t of Object.values(s.tasks)) {
    if (isGone(t)) continue;
    const who = ownerOf(s, t);
    if (!who || who === s.meId || who === AI_ACTOR) continue;
    ids.add(who);
  }
  for (const id of Object.keys(s.users || {})) {
    if (!id || id === s.meId || id === AI_ACTOR) continue;
    ids.add(id);
  }

  const people = [...ids].map((id) => ({ id, label: displayName(s.users?.[id]) || '不认识的成员' }));
  people.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  for (const p of people) out.push({ value: p.id, label: p.label });
  return out;
}

/**
 * 当前筛选值还认不认得。
 *
 * 不认得的两种：人已经不在我的集里了；本地偏好是从别的账号带过来的 id。
 * 两种情况都收回「全部成员」—— 停在一个永远空着的筛选上，用户只会觉得
 * 「今天怎么什么都没有」。
 */
export function creatorFilterValid(s: LocalState): boolean {
  const f = s.ui.creator;
  if (!f || f === 'all') return true;
  if (f === 'me') return !!s.meId;
  return creatorOptions(s).some((o) => o.value === f);
}
