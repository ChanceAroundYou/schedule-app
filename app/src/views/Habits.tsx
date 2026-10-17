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

import { useEffect, useRef, useState } from 'react';
import { Flame, Plus, X } from 'lucide-react';
import type { LocalState } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { habitStreak, liveHabits } from '../domain/model.ts';
import { CheckBtn, Empty, HabitHeat } from './parts.tsx';
import { SortableList } from '../ui/dndkit.tsx';
import { Input, Btn, InlineRename, MiniIconBtn } from '../ui/kit.tsx';
import { renameHabit } from '../ui/habits.ts';

export function HabitsView({ state }: { state: LocalState }) {
  const [draft, setDraft] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  const habits = liveHabits(state).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const today = D.today();

  /**
   * **写完之后才清空草稿** —— 顺序反了会丢词。
   *
   * 不能靠按钮上那个 `onClick={() => setDraft('')}`：它是 React 合成事件，
   * 而真正写库的是 `#content` 上那条原生监听，两者的先后**没有保证**
   * （这条链路上 React 跑在 document 上、原生监听挂在容器上，理论上原生先，
   * 但没人愿意把「添加一条打卡项」的正确性押在事件传播顺序上）。
   * 所以清空改成「看见库里多了一条再清」：`onClick` 只发信号，
   * 这里探测 `habits.length` 涨了才收。首次渲染用 ref 跳过一次，
   * 免得一进页面就清。
   */
  const seen = useRef(habits.length);
  useEffect(() => {
    if (habits.length > seen.current) setDraft('');
    seen.current = habits.length;
  }, [habits.length]);

  const addBar = (
    <div className="habit-add">
      <Input
        type="text"
        id="habitInput"
        placeholder="添加一个打卡项，如：学英语"
        aria-label="添加打卡项"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        data-add-habit="1"
        onKeyDown={(e) => { if (e.key === 'Enter') addRef.current?.click(); }}
      />
      {/* 添加走 App 的点击委托：处理器从 data-add-habit 那个框读词、写 store。
          这个按钮**不自己清空**（清了处理器就读不到词）—— 上面的
          useEffect 看见库里多了一条才收。Enter 只是替用户点一次按钮，
          两条路径汇到同一个处理器，写入仍然只有一处。 */}
      <Btn ref={addRef} variant="primary" data-act="add-habit">
        <Plus size={14} /> 添加
      </Btn>
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
      <SortableList
        items={habits.map((h) => h.id)}
        entity="habit"
        scope="habits"
        renderItem={(id) => {
          const h = state.habits[id];
          const done = !!(h.log && h.log[today]);
          const st = habitStreak(h);
          return (
            <div
              className={'habit-row' + (done ? ' done' : '')}
              data-habit={h.id}
              data-id={h.id}
              data-kind="habit"
            >
              <CheckBtn id={h.id} on={done} act="habit" sm />
              <div className="habit-main">
                {/* 改名走 InlineRename（项目里所有改名同一套交互）。
                    删除挪进它的操作槽第二格：这样「铅笔 + 删除」两态都是两格，
                    标题区宽度不会因为进入编辑态而跳一下。
                    打卡项只有名字可编辑，所以这里没有别的字段。 */}
                <div className="habit-title">
                  <InlineRename
                    value={h.title}
                    label="打卡项名字"
                    onSave={(v) => renameHabit(h.id, v)}
                    display={(
                      <>
                        {h.title}
                        {st > 1 && (
                          <span className="ci-streak" title={'连续打卡 ' + st + ' 天'}>
                            <Flame size={11} style={{ verticalAlign: '-1px' }} /> {st}
                          </span>
                        )}
                      </>
                    )}
                    extraAction={(
                      <MiniIconBtn
                        tone="danger"
                        label="删除打卡项"
                        data-act="del-habit"
                        data-id={h.id}
                        data-title={h.title}
                      >
                        <X size={13} />
                      </MiniIconBtn>
                    )}
                  />
                </div>
                <HabitHeat habit={h} />
              </div>
            </div>
          );
        }}
        className="habit-list mc"
      />
    </div>
  );
}
