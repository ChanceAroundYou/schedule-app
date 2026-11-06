/**
 * Checkin.tsx —— 打卡条 + 热力点 + 折叠三角 + 负载档位
 */

import type { ReactNode } from 'react';
import { Flame, ChevronRight, ChevronLeft } from 'lucide-react';
import type { Habit, LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { bucketsOf, habitStreak } from '../../domain/model.ts';
import { MiniCalendar } from '../../ui/overlays/MiniCalendar.tsx';
import { CheckBtn } from './CheckBtn.tsx';

/* ============================== 打卡条 ============================== */

/**
 * 今天顶部那条横排打卡条。
 *
 * 2026-11-02 起按**打卡分类**分段：每段一个小标题 + 那一类的项。空分类不显示
 * （一屏全是空标题没意义）。**只有一个「未分类」组时不分段**，保持原来的样子
 * —— 没建过分类的用户不该看到多余的标题。
 */
export function CheckinStrip({ state }: { state: LocalState }) {
  const buckets = bucketsOf(state).filter((b) => b.habits.length);
  if (!buckets.length) return null;
  const t = D.today();
  const flat = buckets.length === 1 && !buckets[0].group;
  const total = buckets.reduce((n, b) => n + b.habits.length, 0);
  const done = buckets.reduce((n, b) => n + b.habits.filter((h) => h.log && h.log[t]).length, 0);

  const row = (h: Habit) => {
    const hd = !!(h.log && h.log[t]);
    const st = habitStreak(h);
    return (
      <div className={'ci-item' + (hd ? ' done' : '')} key={h.id} data-habit={h.id}>
        <CheckBtn id={h.id} on={hd} act="habit" />
        <span className="ci-title">{h.title}</span>
        {st > 1 && (
          <span className="ci-streak" title={'连续打卡 ' + st + ' 天'}>
            <Flame size={11} style={{ verticalAlign: '-1px' }} />
            {st}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="checkin-strip">
      <div className="ci-head">
        <span className="ci-sub">今天 {done}/{total}</span>
        {/* 「管理」跳去打卡页 —— **只靠 data-jump-habits**，不另给 onClick。
            委托那条（clickDispatch.ts 第 2 步）会先命中它，再跑 React 合成事件
            就是做两遍同一件事。 */}
        <button className="ci-manage" data-jump-habits="1">管理</button>
      </div>
      {flat ? (
        <div className="ci-list">{buckets[0].habits.map(row)}</div>
      ) : (
        buckets.map((b) => (
          <div className="ci-group" key={b.id || '__none'}>
            <div className="ci-group-name">{b.group ? b.group.name : '未分类'}</div>
            <div className="ci-list">{b.habits.map(row)}</div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * 最近 14 天的打卡热力点（终点 = 正在看的那一天）。
 *
 * 2026-11-06 丙方案：从纯展示的 `<i>` 换成 `<button data-act="habit-heat">` ——
 * 点某个点**是「去看那天」，不是「替那天打卡」**。两个动作长在同一排小方块上，
 * 手一抖就把过去某天误打上勾，而补打是要能反悔的（再点一次才取消）。
 * 所以这里只切日期，打勾仍然回到那一行去点勾选圈。
 */
export function HabitHeat({ habit: h, date }: { habit: Habit; date?: string }) {
  const end = date || D.today();
  const out: ReactNode[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = D.addDays(end, -i);
    const on = !!(h.log && h.log[d]);
    out.push(
      <button
        type="button"
        className={'heat-dot' + (on ? ' on' : '') + (d === end ? ' cur' : '')}
        key={d}
        data-act="habit-heat"
        data-date={d}
        title={D.fmtMD(d) + (on ? ' 已打卡' : ' 未打卡')}
        aria-label={'看 ' + D.fmtMD(d) + (on ? '（已打卡）' : '')}
      />,
    );
  }
  return <div className="habit-heat">{out}</div>;
}

/**
 * 打卡页顶部的日期条（丙方案）：‹ 11月6日 周五 ›。
 *
 * 「任意一天都能打卡」的入口就在这儿 —— 往回翻能补打漏的，往前翻能预打。
 * 中间那块点开是一个小月历（复用 `MiniCalendar`），要跨月补打时不用按二十下。
 *
 * 日期条本身就是状态指示器：离开今天时右边多一个「回到今天」，
 * 中间还会挂上「补打 / 预打」的小标签 —— 打卡是**写历史**的动作，
 * 用户必须一眼看出这一下会写进哪天。
 */
export function HabitDayBar({ date, cal, loadOf }: {
  date: string;
  /** `null` = 月历收起；非空 = 展开，值是显示哪个月（月初） */
  cal: string | null;
  loadOf: (iso: string) => number;
}) {
  const today = D.today();
  const diff = D.diffDays(date, today);
  const tag = diff === 0 ? '今天' : diff < 0 ? '补打' : '预打';
  return (
    <div className="habit-day">
      <div className="habit-day-row">
        <button type="button" className="habit-day-nav" data-act="habit-day" data-delta="-1" aria-label="前一天">
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="habit-day-pick"
          data-act="habit-cal"
          aria-expanded={!!cal}
          aria-label="选日期"
        >
          <span className="habit-day-date">{D.fmtSmart(date)}</span>
          <span className="habit-day-wd">周{D.weekdayShort(date)}</span>
          <span className={'habit-day-tag' + (diff ? ' away' : '')}>{tag}</span>
        </button>
        <button type="button" className="habit-day-nav" data-act="habit-day" data-delta="1" aria-label="后一天">
          <ChevronRight size={15} />
        </button>
        {diff !== 0 && (
          <button type="button" className="habit-day-back" data-act="habit-today">回到今天</button>
        )}
      </div>
      {cal && (
        <div className="habit-cal">
          <MiniCalendar
            month={cal}
            value={date}
            todayIso={today}
            loadOf={loadOf}
            act="habit"
          />
        </div>
      )}
    </div>
  );
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
