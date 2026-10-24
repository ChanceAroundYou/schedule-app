/**
 * RepeatFlag.tsx —— 🔁 重复任务标志（dev 分支 2026-10-24 引入，2026-10-25 合并）
 *
 * 凡带重复规则（按天 / 周 / 月，任何周期）的任务，标题末尾跟一个 🔁，与单次任务
 * 一眼区分。列表行的 meta 里另有周期文案（`m-repeat`，如「每周一、三」）——
 * 两处并存不是重复表达：🔁 是「这是重复任务」的路标，meta 是「具体怎么重复」。
 *
 * **单独一个文件是为了断开循环依赖**：它同时被 `TaskRow`（列表行 / 胶囊）和
 * `TaskCard`（日历卡 / 月胶囊）用，而 `TaskRow` 的 `TaskPill` 又要 import
 * `TaskCard` 的 `CompactCard` —— 把 RepeatFlag 留在 TaskRow 里就成了
 * TaskCard ⇄ TaskRow 互相 import。
 *
 * ⚠️ 这是全项目**唯一**的 emoji（AGENTS.md「图标一律 lucide，零 emoji」的例外），
 * 由用户 2026-10-24 明确要求引入。别照着这条去加第二个。
 */

import type { Task } from '../../domain/types.ts';

export function RepeatFlag({ t }: { t: Task }) {
  if (!t.repeat || t.repeat.unit === 'none') return null;
  return <span className="rep-flag" aria-label="重复任务" title="重复任务">🔁</span>;
}
