/**
 * RepeatPop.tsx —— 重复设置的复合浮层
 *
 * 分两半：**单位那一行**（每 n + 单位）和**单位各自的补充**（周 → 选星期几，
 * 月 → 选几号，年 → 选几月几号）+ **结束方式**。
 *
 * **左上角不写「重复」**（2026-10-11）：它是从抽屉里那个「重复」按钮弹出来的，
 * 按钮上的字就是它的名字，面板里再写一遍只是占一行高度。
 * 关掉走点外面 / Escape（都记在 useDrawer 里）。
 */

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { RepeatRule } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { REPEAT_UNITS, toRepeat } from '../../domain/repeat.ts';
import { DatePicker } from '../DatePicker.tsx';
import { DayGrid } from '../DayGrid.tsx';
import { Chips, Dropdown, IconBtn, Input } from '../kit.tsx';

export function RepeatPop({ rep, patch, next }: {
  rep: RepeatRule;
  /** 合并写当前这份规则：`patch({n})` = `{...rep, n}` */
  patch: (fields: Partial<RepeatRule>) => void;
  /** 下一次落在哪天，只在设了重复之后有 */
  next: string | null;
}) {
  const unit = rep.unit;
  return (
    <>
      <div className="rp-row">
        <span className="rp-every">每</span>
        <input
          type="number"
          min={1}
          step={1}
          className="rp-n"
          value={rep.n}
          onChange={(e) => {
            const n = Math.max(1, Math.floor(Number(e.target.value)) || 1);
            patch({ n });
          }}
          aria-label="重复间隔"
        />
        <Dropdown<RepeatRule['unit']>
          value={unit === 'none' ? null : unit}
          /* 单位下拉**只有天/周/月/年**（2026-10-11）：「不重复」不是一个频率，
             混在单位里等于让用户以为「不重复」也是每 n 个单位 —— 它是抽屉
             那个按钮上的状态，不是下拉里的一项。 */
          options={REPEAT_UNITS.map((u) => ({ value: u.value, label: u.label }))}
          onPick={(u) => {
            /* 切单位时默认值填「今天对应的那个」（用户 2026-10-10）：
               周 → 今天星期几；月 → 今天几号；年 → 今天几月几号。
               原先切过去拿到的是任务日期推的默认值（emptyRepeat 用的 date），
               用户看到的第一个东西和自己手点的这一下对不上。 */
            const todayIso = D.today();
            const td = D.parseISO(todayIso);
            const next = toRepeat({ ...rep, unit: u, n: 1, end: null }, todayIso);
            if (u === 'week') next.weekdays = [td.getDay()];
            if (u === 'month') next.monthday = td.getDate();
            if (u === 'year') { next.yearMonth = td.getMonth() + 1; next.monthday = td.getDate(); }
            patch(next);
          }}
          label="重复单位"
          className="rp-unit"
          /* 需求2：单位下拉的菜单要能浮在面板之上、超出面板边界。
             面板是 overflow-y:auto，默认会把绝对定位的菜单裁掉 ——
             菜单 z-[60] 也低于面板自身的 z-70。 */
          menuClassName="!z-[9999] max-h-96"
        />
      </div>

      {unit === 'week' && (
        <div className="rp-row rp-wd">
          {['一', '二', '三', '四', '五', '六', '日'].map((w, i) => {
            const v = i === 6 ? 0 : i + 1;
            const on = rep.weekdays.includes(v);
            return (
              <button
                className={'rp-day' + (on ? ' on' : '')}
                key={w}
                aria-pressed={on}
                onClick={() => patch({
                  weekdays: on ? rep.weekdays.filter((x) => x !== v) : [...rep.weekdays, v],
                })}
              >{w}</button>
            );
          })}
        </div>
      )}

      {unit === 'month' && (
        <div className="rp-row">
          <DayGrid selected={rep.monthday} onPick={(d) => patch({ monthday: d })} label="每月几号" />
        </div>
      )}

      {unit === 'year' && (
        <>
          <div className="rp-row rp-month">
            <button className="dp-nav-btn" type="button" aria-label="上个月" onClick={() => patch({ yearMonth: (rep.yearMonth || 1) <= 1 ? 12 : (rep.yearMonth || 1) - 1 })}>
              <ChevronLeft size={14} />
            </button>
            <span className="rp-month-label">{rep.yearMonth || 1} 月</span>
            <button className="dp-nav-btn" type="button" aria-label="下个月" onClick={() => patch({ yearMonth: (rep.yearMonth || 1) >= 12 ? 1 : (rep.yearMonth || 1) + 1 })}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="rp-row">
            <DayGrid selected={rep.monthday} onPick={(d) => patch({ monthday: d })} label="每年几月几号" />
          </div>
        </>
      )}

      {unit !== 'none' && (
        <div className="rp-row">
          <span>结束</span>
          <Chips<string>
            value={rep.end?.type || 'never'}
            options={['never', 'date', 'count']}
            onPick={(v) => {
              patch({
                end: v === 'date' ? { type: 'date', date: D.addMonths(D.today(), 3) }
                  : v === 'count' ? { type: 'count', count: 10 }
                    : null,
              });
            }}
            labelOf={(v) => ({ never: '不限', date: '到某天', count: '重复几次' } as Record<string, string>)[v] || v}
            label="重复结束方式"
          />
          {rep.end?.type === 'date' && (
            <DatePicker
              value={rep.end.date}
              onChange={(v) => {
                if (v) patch({ end: { type: 'date', date: v } });
              }}
            />
          )}
          {rep.end?.type === 'count' && (
            <Input
              type="number" min={1} max={999} value={rep.end.count}
              onChange={(e) => patch({ end: { type: 'count', count: Math.max(1, +e.target.value || 1) } })}
            />
          )}
        </div>
      )}

      {unit !== 'none' && next && <div className="rp-preview">下一次：{D.fmtMD(next)}</div>}
    </>
  );
}

/** 面板外壳：**右上角那个关闭钮**（点字外面也能关，那两个监听在 useDrawer 里）。 */
export function RepeatPopCloseBtn({ onClose }: { onClose: () => void }) {
  return (
    <div className="repeat-pop-head">
      <IconBtn label="关闭" onClick={onClose}><X size={15} /></IconBtn>
    </div>
  );
}
