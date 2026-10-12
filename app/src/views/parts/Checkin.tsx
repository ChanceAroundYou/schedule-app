/**
 * Checkin.tsx —— 打卡条 + 热力点 + 折叠三角 + 负载档位
 */

import type { ReactNode } from 'react';
import { Flame, ChevronRight } from 'lucide-react';
import type { Habit } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { habitStreak } from '../../domain/model.ts';
import { CheckBtn } from './CheckBtn.tsx';

/* ============================== 打卡条 ============================== */

export function CheckinStrip({ habits, onManage }: {
  habits: Habit[];
  /** 「管理」按钮跳去打卡页。其余交互（勾选）走事件委托 */
  onJumpHabits?: () => void;
  onManage?: () => void;
}) {
  if (!habits.length) return null;
  const t = D.today();
  const done = habits.filter((h) => h.log && h.log[t]).length;

  return (
    <div className="checkin-strip">
      <div className="ci-head">
        每日打卡
        <span className="ci-sub">今天 {done}/{habits.length}</span>
        <button className="ci-manage" data-jump-habits="1" onClick={onManage}>管理</button>
      </div>
      <div className="ci-list">
        {habits.map((h) => {
          const hd = !!(h.log && h.log[t]);
          const st = habitStreak(h);
          return (
            <div className={'ci-item' + (hd ? ' done' : '')} key={h.id} data-habit={h.id}>
              <CheckBtn id={h.id} on={hd} act="habit" sm />
              <span className="ci-title">{h.title}</span>
              {st > 1 && (
                <span className="ci-streak" title={'连续打卡 ' + st + ' 天'}>
                  <Flame size={11} style={{ verticalAlign: '-1px' }} />
                  {st}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 最近 14 天的打卡热力点 */
export function HabitHeat({ habit: h }: { habit: Habit }) {
  const out: ReactNode[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = D.addDays(D.today(), -i);
    const on = !!(h.log && h.log[d]);
    out.push(<i className={'heat-dot' + (on ? ' on' : '')} key={d} title={d + (on ? ' 已打卡' : '')} />);
  }
  return <div className="habit-heat">{out}</div>;
}

/** 可折叠区块的三角。用图标不用字符，字号变化时不会错位 */
export function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={14}
      className="td-caret"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
    />
  );
}

/** 一天的任务负载档位（周视图表头、月视图格子共用同一套分档） */
export function loadLevel(mins: number): number {
  if (!mins) return 0;
  if (mins > 8 * 60) return 3;
  if (mins > 4 * 60) return 2;
  return 1;
}
