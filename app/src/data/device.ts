/**
 * device.ts —— 设备标识
 *
 * 用途只有一个：LWW 在时间戳撞车时的**确定性**平局破解。两台设备各写一次、
 * 毫秒时间戳相同，必须都算出同一个赢家，否则永远收敛不了。
 *
 * 存 localStorage 而不是每次随机生成 —— 重启一次换一个 id 的话，这个设备
 * 之前写下的那些 op 在新一轮比较里就变成了「另一台设备」，平局规则会翻脸。
 */

import { newId } from '../domain/model.ts';

const KEY = 'schedule-app-device';

let cached: string | null = null;

export function deviceId(): string {
  if (cached) return cached;
  try {
    const s = localStorage.getItem(KEY);
    if (s) { cached = s; return s; }
  } catch (_) { /* 隐私模式下 localStorage 可能不可用 */ }

  cached = newId();
  try { localStorage.setItem(KEY, cached); } catch (_) { /* 同上 */ }
  return cached;
}
