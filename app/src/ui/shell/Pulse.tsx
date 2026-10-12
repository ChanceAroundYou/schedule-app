/**
 * Pulse.tsx —— 侧栏底部「今日进度」
 */

import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { counts, liveTasks } from '../../domain/model.ts';

/**
 * 侧栏底部那块「今日进度」，窄屏的「更多」抽屉里也放一份 —— 同一份数据同一套
 * 标记，两处不能各算各的（数字对不上时用户第一个发现）。
 *
 * 口径与其它徽标不同，**故意不同**：这里的分母是「今天排了的事」全部
 * （含已完成），分子是其中做完的。`counts().today` 是「今天还没做的」，
 * 拿它当分子会算出永远 0% 的进度条。
 */
export function Pulse({ state }: { state: LocalState }) {
  const t = D.today();
  const all = liveTasks(state).filter((x) => x.date === t);
  const undone = all.filter((x) => !x.done).length;
  const done = all.length - undone;
  const over = counts(state).overdue;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div className={'side-pulse' + (all.length && !undone ? ' all-done' : '')}>
      <div className="sp-head">
        <span className="sp-title">今日进度</span>
        <span className="sp-num"><b>{done}</b>/{all.length}</span>
      </div>
      <div className="sp-bar"><i style={{ width: pct + '%' }} /></div>
      <div className="sp-foot">
        {all.length ? (undone ? `还剩 ${undone} 件` : '今天清空了') : '今天还没有安排'}
        {!!over && <span className="sp-over">逾期 {over}</span>}
      </div>
    </div>
  );
}
