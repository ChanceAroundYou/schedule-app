/**
 * RepeatFlag.tsx —— 重复任务标志（dev 分支 2026-10-24 引入，2026-10-25 合并）
 *
 * 凡带重复规则（按天 / 周 / 月，任何周期）的任务，标题末尾挂一个循环图标，与单次
 * 任务一眼区分。列表行的 meta 里另有周期文案（`m-repeat`，如「每周一、三」）——
 * 两处并存不是重复表达：图标是「这是重复任务」的路标，meta 是「具体怎么重复」。
 *
 * **开不开由设置页「显示」›「重复标记」管**（`ui.showRepeatMark`，必填 prop 往下传）：
 * 2026-10-28 起日历卡右上角那枚和列表行标题末尾这枚**一起管** —— 之前这开关只捏着
 * 卡片那枚，列表行照画，「关掉重复标记」在两个页面给出两个答案。
 *
 * **单独一个文件是为了断开循环依赖**：它同时被 `TaskRow`（列表行 / 胶囊）和
 * `TaskCard`（日历卡 / 月胶囊）用，而 `TaskRow` 的 `TaskPill` 又要 import
 * `TaskCard` 的 `CompactCard` —— 把 RepeatFlag 留在 TaskRow 里就成了
 * TaskCard ⇄ TaskRow 互相 import。
 *
 * 演进史（三次都是用户裁决）：
 *   1. 2026-10-24 字符 🔁 —— 用户：重复任务要和单次任务一眼区分。
 *   2. 2026-10-25 换 ↻ 描线符号 —— emoji 在部分机型渲染成黄铜色，和青玉色板打架。
 *   3. 2026-10-25 晚 换**真图标**（lucide `Repeat`）—— 用户：「做成真正的 icon
 *      而非 emoji，粗一点、大一点点，背景透明不占位置」。emoji/符号都受字体渲染
 *      摆布（字重、基线、彩色化），线条图标才能保证粗细一致。尺寸与描边见
 *      `calendar.css` 的 `.rep-flag`（透明无底、不撑行高、角标档绝对定位不占位）。
 */

import { Repeat } from 'lucide-react';

import type { Task } from '../../domain/types.ts';

export function RepeatFlag({ t, corner }: { t: Task; corner?: boolean }) {
  if (!t.repeat || t.repeat.unit === 'none') return null;
  /* corner：日/周任务卡的**右上角层角标**档（绝对定位、不占文字宽度）；
     不传 = 列表行里的内联图标。同一枚图标，两种站位（见 calendar.css）。
     strokeWidth：lucide 默认 2 在 11-13px 的渲染尺寸下偏细（实际线宽 ≈1px），
     用户要求「粗一点」→ 3（≈1.5px），小尺寸角标也够清楚。 */
  return (
    <span
      className={'rep-flag' + (corner ? ' rep-flag--corner' : '')}
      aria-label="重复任务"
      title="重复任务"
    >
      <Repeat strokeWidth={3} aria-hidden="true" />
    </span>
  );
}
