/**
 * deny.ts —— 权限拒绝的**唯一**记录入口
 */

/**
 * 「这次没写成，因为没有写权限」。
 *
 * 每个写入通道各自记一遍必然会漏（`moveToCal` 就漏过：它在自己的函数里
 * 直接 `return`，什么都不说，用户看到的是「点了一下没反应」）。
 * 所以别在调用点自己动 `state.denied`，一律走这里。
 *
 * `calIds` 是这一批涉及到的集，去重后记进 `deniedCals` 给提示用。
 * 只读成员看到的不是「藏起来」，是「点了会告诉你为什么」。
 */
import { state, emit } from './core.ts';

export function deny(calIds: (string | null | undefined)[]): void {
  const cals: string[] = [];
  for (const c of calIds) if (c && !cals.includes(c)) cals.push(c);
  state.denied++;
  state.deniedCals = cals;
  emit();
}