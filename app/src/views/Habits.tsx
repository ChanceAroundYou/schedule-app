/**
 * Habits.tsx —— 打卡视图
 *
 * 数据结构上叫 `habits`，**界面文案一律「打卡」**，不写「习惯」。
 *
 * ## 分组（2026-11-02）
 *
 * 打卡项按「打卡分类」分区显示，组头可折叠、可改名、可删；**拖到别的组
 * 就是换分类**（跨容器拖拽，实现在 `ui/dnd/groups.tsx`）。
 *
 * 几个刻意的取舍：
 *   · 只有**一个组且是未分类**时不画组头 —— 没建过分类的用户看到的还是
 *     原来那条平铺列表，不因为升级多冒出来一个「未分类」标题。
 *   · 空分类照样显示（用户刚建完还没往里放东西，它不能凭空消失）；
 *     「未分类」反过来 —— 只在真有未归类的项时才出现。
 *   · 折叠状态落 `ui.closedGroups`（本地偏好，不跨设备）。
 *
 * 删除按钮不直接调 confirm：由 App 的委托处理器拿 useConfirm 问一次再删，
 * 所以这里只留一个 data-title 让确认框能写出「删的是哪一个」。
 */

import { useEffect, useRef, useState } from 'react';
import { Flame, Plus, X } from 'lucide-react';
import type { Habit, LocalState } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { habitStreak, habitBestStreak, habitDaySummary, bucketsOf, groupTodayCount, defaultAddGroup, UNGROUPED } from '../domain/model.ts';
import { CheckBtn, Empty, HabitHeat, HabitDayBar, Caret } from './parts.tsx';
import { SortableGroups, type SortableGroupData } from '../ui/dndkit.tsx';
import { Input, Btn, InlineRename, MiniIconBtn, Dropdown } from '../ui/kit.tsx';
import {
  renameHabit, renameHabitGroup, moveHabit, seedGroups, createHabitGroup, setAddGroup,
} from '../ui/habits.ts';

export function HabitsView({ state }: { state: LocalState }) {
  const [draft, setDraft] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  const today = D.today();
  /**
   * 正在看/正在打哪一天（丙方案，2026-11-06）。
   *
   * `ui.habitDate` 为 null 就是今天。翻到过去叫补打、翻到未来叫预打 ——
   * 三个动作走**同一个**勾选圈、同一条写库路径（`store.toggleHabit(id, date)`），
   * 不另造一套「补打模式」，否则规则会分叉（比如补打到底算不算连续天数）。
   *
   * ⚠️ 这个值每次载入都会被 normalizeUi 清回 null（见 model/ui.ts 的注释）：
   * 昨天补完没翻回来、今天一打开还在昨天，那一勾就写进了历史，用户当场看不出。
   */
  const viewDate = state.ui.habitDate || today;
  const isToday = viewDate === today;

  const buckets = bucketsOf(state);
  const closed = state.ui.closedGroups || [];
  /* 只有一组、且是「未分类」→ 不画组头。老用户升级上来看到的还是原来那条列表 */
  const flat = buckets.length === 1 && buckets[0].id === UNGROUPED;

  /**
   * 全新账号第一次进打卡页：播下默认分类。
   *
   * 两个条件都齐了才播：拿到过私有打卡集（`habitsCal`，否则写进去的归属是猜的）、
   * 且一条分类都没有（删除会留墓碑，所以「删光了」不会被当成「还没有」）。
   */
  const groupCount = Object.keys(state.habitGroups).length;
  useEffect(() => {
    if (!groupCount && state.habitsCal) seedGroups();
  }, [groupCount, state.habitsCal]);

  /**
   * **写完之后才清空草稿** —— 顺序反了会丢词。
   *
   * 不能靠按钮上那个 `onClick={() => setDraft('')}`：它是 React 合成事件，
   * 而真正写库的是 `#content` 上那条原生监听，两者的先后**没有保证**。
   * 所以清空改成「看见库里多了一条再清」：`onClick` 只发信号，
   * 这里探测总数涨了才收。首次渲染用 ref 跳过一次，免得一进页面就清。
   */
  const total = buckets.reduce((n, b) => n + b.habits.length, 0);
  const seen = useRef(total);
  useEffect(() => {
    if (total > seen.current) setDraft('');
    seen.current = total;
  }, [total]);

  /* 一条分类都没有时不给选择器：一上来只有「未分类」一项，那个下拉是纯噪音 */
  const pickable = groupCount > 0;
  /**
   * 「加到哪个分类」：选过一次就一直用它（连加几条不用每次重选）。
   *
   * 口径在 `defaultAddGroup`，**点击委托用的是同一个函数** —— 2026-11-06
   * 两边各算一遍，一边 `|| 空串`、一边 `|| 第一个组`，结果下拉显示「工作学习」、
   * 新项却落进「未分类」。
   */
  const addGroup = defaultAddGroup(state);

  /* 汇总口径跨**所有**打卡项（不分分类）：用户想看的是「今天到底清了几项」，
     按组各报一个数字反而要在脑子里加总。 */
  const allHabits = buckets.reduce<Habit[]>((a, b) => a.concat(b.habits), []);
  const sum = habitDaySummary(allHabits, viewDate);
  /* 「本月」只在看本月的日子时才叫本月。翻到 10 月还写「本月」、
     数字却是 10 月的，那是在骗人；翻到未来更没有「本月已过几天」这回事。 */
  const inThisMonth = D.monthStart(viewDate) === D.monthStart(today);
  const monthLabel = inThisMonth ? '本月' : (D.parseISO(viewDate).getMonth() + 1) + ' 月';

  const dayHead = (
    <>
      <HabitDayBar
        date={viewDate}
        cal={state.ui.habitCal}
        /* 月历里那根短横 = 那天打了几个。日历的密度语义在打卡页翻过来用：
           日程页表示「这天有多少活」，这里表示「这天完成了几件」。 */
        loadOf={(iso) => allHabits.filter((h) => h.log && h.log[iso]).length}
      />
      <div className="habit-sum">
        <span className="habit-sum-i" title="所有打卡项里最长的那条当前连续">
          <Flame size={11} className="habit-sum-flame" />
          <b>{sum.best}</b><span className="habit-sum-t">天连续</span>
        </span>
        <span className="habit-sum-sep" aria-hidden="true" />
        <span className="habit-sum-i" title="历史最长连续（断过也记得）">
          <b>{sum.bestEver}</b><span className="habit-sum-t">天最长</span>
        </span>
        <span className="habit-sum-sep" aria-hidden="true" />
        <span className="habit-sum-i" title={'有打卡的天数 / ' + monthLabel + '已过天数'}>
          <b>{sum.month}</b><span className="habit-sum-t">/{sum.monthDays} 天 · {monthLabel}</span>
        </span>
      </div>
    </>
  );

  const addBar = (
    <div className="habit-add">
      {pickable && (
        /* 原生 `<select>` 换成 Dropdown（2026-11-06）：项目约定零原生 select
          （color-scan 一直在报这一处）。值落 `ui.addGroup`，委托那边从
          触发按钮的 `data-add-habit-group` 读 —— 不再靠 DOM 里的 form value。 */
        <Dropdown
          className="habit-group-pick"
          label="加到哪个分类"
          size="sm"
          value={addGroup}
          options={buckets.map((b) => ({
            value: b.id,
            label: b.group ? b.group.name : '未分类',
          }))}
          onPick={(gid) => setAddGroup(gid)}
          /* 委托那边读 `data-add-habit-group` 的**存在**（判断有没有选择器），
             真正选中的分类改从 `ui.addGroup` 读 —— 见 clickDispatch 的 add-habit */
          data={{ 'data-add-habit-group': '1' }}
        />
      )}
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

  if (!total && !groupCount) {
    return (
      <div className="habits-view">
        {addBar}
        <Empty text="还没有打卡项，先加一个每天想坚持的事" icon={<Flame size={30} strokeWidth={1.4} />} />
      </div>
    );
  }

  const renderRow = (id: string) => {
    const h = state.habits[id];
    if (!h) return null;
    /* 勾的是**正在看的那天**，不是今天 —— 这就是补打/预打的全部实现 */
    const done = !!(h.log && h.log[viewDate]);
    const st = habitStreak(h, viewDate);
    const best = habitBestStreak(h);
    return (
      <div
        className={'habit-row' + (done ? ' done' : '')}
        data-habit={h.id}
        data-id={h.id}
        data-kind="habit"
      >
        {/* 非今天才把日期带下去：今天那条保持原来的 DOM（老的自动化断言按
            「有 data-date 就是特殊态」来判断会踩空，所以今天干脆不带） */}
        <CheckBtn id={h.id} on={done} act="habit" date={isToday ? undefined : viewDate} />
        <div className="habit-main">
          {/* 改名走 InlineRename（项目里所有改名同一套交互）。
              删除挪进它的操作槽第二格：这样「铅笔 + 删除」两态都是两格，
              标题区宽度不会因为进入编辑态而跳一下。 */}
          <div className="habit-title">
            <InlineRename
              value={h.title}
              label="打卡项名字"
              onSave={(v) => renameHabit(h.id, v)}
              display={(
                <>
                  {h.title}
                  {st > 1 && (
                    <span className="ci-streak" title={`连续 ${st} 天 · 历史最长 ${best} 天`}>
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
          <HabitHeat habit={h} date={viewDate} />
        </div>
      </div>
    );
  };

  /* 还没有任何分类：保持原来的单容器排序（一个不可见的「未分类」组） */
  if (flat) {
    return (
      <div className="habits-view">
        {dayHead}
        {addBar}
        <SortableGroups
          groups={[{ id: UNGROUPED, items: buckets[0].habits.map((h) => h.id) }]}
          onDrop={(id, to, refId) => moveHabit(id, to, refId)}
          renderHeader={() => null}
          renderItem={renderRow}
        />
      </div>
    );
  }

  const groups: SortableGroupData[] = buckets.map((b) => ({
    id: b.id,
    // 折叠的组不渲染行：拖不进去是有意的（先展开再拖）
    items: closed.includes(b.id) ? [] : b.habits.map((h) => h.id),
  }));

  return (
    <div className="habits-view">
      {dayHead}
      {addBar}
      <SortableGroups
        groups={groups}
        onDrop={(id, to, refId) => moveHabit(id, to, refId)}
        emptyHint={<span className="hgroup-empty">还没有打卡项</span>}
        renderItem={renderRow}
        renderHeader={(gid) => {
          const b = buckets.find((x) => x.id === gid);
          if (!b) return null;
          const { done, total: n } = groupTodayCount(b.habits, viewDate);
          const open = !closed.includes(gid);
          return (
            <div className="hgroup-head" data-closed={open ? '0' : '1'}>
              <button
                className="hgroup-caret"
                data-act="toggle-group"
                data-group={gid}
                aria-expanded={open}
                aria-label={open ? '收起这一组' : '展开这一组'}
              >
                <Caret open={open} />
              </button>
              {b.group ? (
                <InlineRename
                  value={b.group.name}
                  label="分类名字"
                  onSave={(v) => renameHabitGroup(gid, v)}
                  display={(
                    <>
                      <span className="hgroup-name">{b.group.name}</span>
                      <span className="hgroup-count">{done}/{n}</span>
                    </>
                  )}
                  extraAction={(
                    <MiniIconBtn
                      tone="danger"
                      label="删除分类"
                      data-act="del-group"
                      data-group={gid}
                      data-title={b.group.name}
                    >
                      <X size={13} />
                    </MiniIconBtn>
                  )}
                />
              ) : (
                <>
                  <span className="hgroup-name hgroup-name--none">未分类</span>
                  <span className="hgroup-count">{done}/{n}</span>
                </>
              )}
            </div>
          );
        }}
      />

      {/* 「新建分类」用 `<details>`：展开不需要 JS，也就不需要 views 里存状态
          （views 是纯展示、零回调）。回车提交在这里做，跟「创建」按钮
          （走委托）汇到同一个 store 入口。 */}
      <details className="hgroup-new">
        <summary><Plus size={13} /> 新建分类</summary>
        <div className="habit-add">
          <Input
            type="text"
            placeholder="分类名字，如：阅读"
            aria-label="新建分类名字"
            autoComplete="off"
            data-add-group="1"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const box = e.target as HTMLInputElement;
              const v = box.value.trim();
              if (!v) return;
              createHabitGroup(v);
              box.value = '';
            }}
          />
          <Btn variant="primary" data-act="add-group">创建</Btn>
        </div>
      </details>
    </div>
  );
}
