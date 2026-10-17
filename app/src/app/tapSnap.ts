/**
 * tapSnap.ts —— 「手指按下那一刻」的坐标快照
 *
 * ## 为什么需要它（2026-10-17 真机事故）
 *
 * 时间轴上的落点 = 点下去的位置 ÷ 时间轴当前高度。这两个数必须来自**同一个时刻**。
 *
 * 原来的写法是在 `click` 里现算：`e.clientY - rect.top`。平时没问题，
 * 但键盘弹起着的时候点空白会这样走：
 *
 * ```
 * pointerdown   clientY = 320        ← 键盘弹着，时间轴只有 199px（坐标系 A）
 *   ↓ 这一下让输入框失焦 → 键盘收起
 * 【布局重排】时间轴变成 611px        ← 坐标系 B
 * click         e.clientY 还是 320，但 rect 已经是 611
 *               → 320 ÷ 611 × 1440 ≈ 754 分钟 → 落成 7:00（点的是 21:00）
 * ```
 *
 * 实测复现：点 21:00 落成 7:00，偏 14 小时。
 *
 * 解法：在 `pointerdown`（布局还没任何变化）就把「这是几点」算完存起来，
 * `click` 只取结果，**不再读 rect**。这样键盘怎么抖都不影响。
 *
 * 快照用一次就作废，并且要求 zoneId 相同、间隔 1.5s 内、坐标差 4px 内 ——
 * 防止滚动后残留的旧快照被误用。任一条不满足就退回现场算（今天的行为）。
 */

import { DAY_H, yToMin } from '../domain/layout.ts';
import { domWindow } from './domWindow.ts';

export interface TapSnap {
  /** 抓取的时刻（ms）。太老就不认了 */
  ts: number;
  x: number;
  y: number;
  /** 哪个区（`timeline:2026-10-17` 这种） */
  zoneId: string;
  /** **已经换算好的分钟**，这是整件事的重点：它只跟按下那一刻的布局有关 */
  min: number;
}

let snap: TapSnap | null = null;

/** 挂在 `document` 的 pointerdown（捕获阶段）上 —— 比任何业务监听都早 */
export function captureTap(e: PointerEvent): void {
  snap = null;
  const t = e.target as HTMLElement | null;
  const zone = t?.closest?.('[data-zone-id]') as HTMLElement | null;
  if (!zone) return;

  const zid = zone.dataset.zoneId || '';
  const kind = zid.slice(0, zid.indexOf(':'));
  /* 只有这两种区要按纵坐标换算时间。全天区 / 月格子 / 泳道列只要日期，
     没有「坐标系」这回事，存快照没意义。 */
  if (kind !== 'timeline' && kind !== 'week') return;

  const r = zone.getBoundingClientRect();
  let min: number;
  if (kind === 'timeline') {
    min = yToMin(e.clientY - r.top, r.height, domWindow(zone));
  } else {
    min = Math.max(0, Math.min(1425, Math.round(((e.clientY - r.top) / DAY_H) * 1440 / 15) * 15));
  }
  snap = { ts: Date.now(), x: e.clientX, y: e.clientY, zoneId: zid, min };
}

/**
 * 取这次点击对应的快照。取到就作废（一次点击只该用一次）。
 * 不匹配返回 null —— 调用方负责退回现场计算。
 */
export function takeTap(x: number, y: number, zone: HTMLElement): TapSnap | null {
  const s = snap;
  if (!s) return null;
  if (s.zoneId !== (zone.dataset.zoneId || '')) return null;
  if (Date.now() - s.ts > 1500) return null;          // 触摸设备上按下到 click 可能慢
  if (Math.abs(s.x - x) > 4 || Math.abs(s.y - y) > 4) return null;   // 手指挪过/页面滚过
  snap = null;
  return s;
}
