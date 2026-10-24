/**
 * RepeatFlag.tsx —— ↻ 重复任务标志（dev 分支 2026-10-24 引入，2026-10-25 合并）
 *
 * 凡带重复规则（按天 / 周 / 月，任何周期）的任务，标题末尾挂一个 ↻，与单次任务
 * 一眼区分。列表行的 meta 里另有周期文案（`m-repeat`，如「每周一、三」）——
 * 两处并存不是重复表达：↻ 是「这是重复任务」的路标，meta 是「具体怎么重复」。
 *
 * **单独一个文件是为了断开循环依赖**：它同时被 `TaskRow`（列表行 / 胶囊）和
 * `TaskCard`（日历卡 / 月胶囊）用，而 `TaskRow` 的 `TaskPill` 又要 import
 * `TaskCard` 的 `CompactCard` —— 把 RepeatFlag 留在 TaskRow 里就成了
 * TaskCard ⇄ TaskRow 互相 import。
 *
 * ⚠️ 2026-10-25 dev 把 🔁 emoji 换成 ↻ 描线符号：emoji 在部分机型渲染成
 * 黄铜色，和青玉色板打架。描线符号继承 `color: var(--text-3)`，色调永远跟着主题走。
 * 由用户明确要求引入（AGENTS.md「图标一律 lucide，零 emoji」的例外）。
 */

import type { Task } from '../../domain/types.ts';

export function RepeatFlag({ t, corner }: { t: Task; corner?: boolean }) {
  if (!t.repeat || t.repeat.unit === 'none') return null;
  /* corner：日/周任务卡的**右上角层角标**档（绝对定位、不占文字宽度）；
     不传 = 列表行里的内联小符号。两者同一个中性符号 ↻（见 calendar.css）。 */
  return (
    <span
      className={'rep-flag' + (corner ? ' rep-flag--corner' : '')}
      aria-label="重复任务" title="重复任务"
    >↻</span>
  );
}
