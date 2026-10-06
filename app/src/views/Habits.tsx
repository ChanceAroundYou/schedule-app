/**
 * Habits.tsx —— 打卡视图
 *
 * 数据结构上叫 `habits`，**界面文案一律「打卡」**，不写「习惯」。
 *
 * 打卡列表也走拖放排序（`data-drop="list"` + `data-kind="habit"`）。
 * `data-kind` 是必须的：拖放层靠它决定取 `[data-habit]` 还是 `[data-untimed]`，
 * 也靠它把打卡挡在任务容器外 —— 两者字段不同（打卡用 order，任务用 ord），
 * 走错会写坏数据。
 *
 * 删除按钮不直接调 confirm：由 App 的委托处理器拿 useConfirm 问一次再删，
 * 所以这里只留一个 data-title 让确认框能写出「删的是哪一个」。
 */

import { useState } from 'react';
import { Flame, Plus, X } from 'lucide-react';
import type { LocalState } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { habitStreak, liveHabits } from '../domain/model.ts';
import { CheckBtn, Empty, HabitHeat } from './parts.tsx';

export function HabitsView({ state, onAdd }: { state: LocalState; onAdd: (title: string) => void }) {
  const [draft, setDraft] = useState('');
  const habits = liveHabits(state).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const today = D.today();

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    onAdd(v);
  };

  const addBar = (
    <div className="habit-add">
      <input
        type="text"
        id="habitInput"
        placeholder="添加一个打卡项，如：学英语"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
      />
      <button className="primary-btn" onClick={add}><Plus size={14} /> 添加</button>
    </div>
  );

  if (!habits.length) {
    return (
      <div className="habits-view">
        {addBar}
        <Empty text="还没有打卡项，先加一个每天想坚持的事" icon={<Flame size={30} strokeWidth={1.4} />} />
      </div>
    );
  }

  return (
    <div className="habits-view">
      {addBar}
      <div className="habit-list mc" data-drop="list" data-scope="habits" data-kind="habit">
        {habits.map((h) => {
          const done = !!(h.log && h.log[today]);
          const st = habitStreak(h);
          return (
            <div
              className={'habit-row' + (done ? ' done' : '')}
              key={h.id}
              data-habit={h.id}
              data-id={h.id}
              data-kind="habit"
              draggable
            >
              <CheckBtn id={h.id} on={done} act="habit" sm />
              <div className="habit-main">
                <div className="habit-title">
                  {h.title}
                  {st > 1 && (
                    <span className="ci-streak" title={'连续打卡 ' + st + ' 天'}>
                      <Flame size={11} style={{ verticalAlign: '-1px' }} /> {st}
                    </span>
                  )}
                </div>
                <HabitHeat habit={h} />
              </div>
              <button
                className="habit-del"
                data-act="del-habit"
                data-id={h.id}
                data-title={h.title}
                title="删除打卡项"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
