/**
 * RepeatPop.tsx —— 重复设置的复合浮层
 *
 * 分两半：**单位那一行**（每 n + 单位）和**单位各自的补充**（周 → 选星期几，
 * 月 → 选几号，年 → 选几月几号）+ **结束方式**。
 *
 * **左上角不写「重复」、也没有标题行和关闭钮**（2026-10-11）：它是从抽屉
 * 里那个「重复」按钮弹出来的，按钮上的字就是它的名字。关掉走点外面 /
 * Escape（都记在 useDrawer 里）。
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { RepeatRule } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { REPEAT_UNITS, toRepeat } from '../../domain/repeat.ts';
import { DatePicker } from '../overlays/DatePicker.tsx';
import { DayGrid } from '../DayGrid.tsx';
import { Chips, Dropdown } from '../kit.tsx';

/**
 * 次数输入框。**允许清空重输**（用户 2026-10-12）：受控输入框把空值当场
 * clamp 回 1，用户连「删掉改成 1」都做不到 —— 默认的 1 像锁死了一样。
 * 这里用本地草稿，清空时展示空、不写库，失焦才落回真实值。
 *
 * **用裸 `<input>` 而不是 `Input` 组件**（用户 2026-10-12：「两个数字输入框
 * ……一个选中以后有明显的 PX 的光晕，另一个是没有光晕的，请把它们进行更加
 * 彻底的统一」）。`Input` 组件自带 Tailwind 的 `py-2` / `px-3` / `focus:shadow`
 * 一整套，和上面那个裸 `<input>` 的间隔框是**两套样式**，高度和 focus 光晕
 * 必然对不齐。两个框只差宽度，样式统一交给 `.repeat-pop input.rp-n/.rp-count`。
 */
function CountInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number" min={1} max={999} className="rp-count"
      aria-label="重复次数"
      value={draft ?? String(value)}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        const n = Math.floor(Number(v));
        if (n >= 1) onChange(Math.min(n, 999));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function RepeatPop({ rep, patch, next, last }: {
  rep: RepeatRule;
  /** 合并写当前这份规则：`patch({n})` = `{...rep, n}` */
  patch: (fields: Partial<RepeatRule>) => void;
  /** 下一次落在哪天，只在设了重复之后有 */
  next: string | null;
  /** 最后一次落在哪天，「不结束」时为 null */
  last: string | null;
}) {
  const unit = rep.unit;
  return (
    <>
      <div className="rp-row">
        <span className={"rp-every"}>每</span>
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
          className={"rp-unit"}
          /* `size="sm"` → `h-[30px]`：跟这一排的数字框、下面那排 Chips 严格同高。
             默认的 `md` 走 Tailwind `h-9`，而本项目 `html { font-size: 14px }`
             让 1rem = 14px，`h-9` 实际是 31.5px —— 比 neighbor 高 1.5px。 */
          size="sm"
          /* 需求2：单位下拉的菜单要能浮在面板之上、超出面板边界。
             面板是 overflow-y:auto，默认会把绝对定位的菜单裁掉 ——
             菜单 z-[60] 也低于面板自身的 z-70。 */
          menuClassName="!z-[9999] max-h-96"
        />
      </div>

      {unit === 'week' && (
        <div className={'rp-row' + ' rp-wd'}>
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
          <div className={'rp-row' + ' rp-month'}>
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
                /* 默认按日期结束 = **下一次发生日**（用户 2026-10-12）：
                   原先写死 today+3 个月，用户看到的第一个日期和自己设的
                   重复规则毫无关系。用 next —— 就是上面那行「下一次」
                   显示的同一个值，用户能直接对上。 */
                end: v === 'date' ? { type: 'date', date: next || D.addMonths(D.today(), 3) }
                  : v === 'count' ? { type: 'count', count: 10 }
                    : null,
              });
            }}
            labelOf={(v) => ({ never: '不结束', date: '按日期', count: '按次数' } as Record<string, string>)[v] || v}
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
            <CountInput
              value={rep.end.count}
              onChange={(v) => patch({ end: { type: 'count', count: v } })}
            />
          )}
        </div>
      )}

      {unit !== 'none' && (
        <div className={"rp-preview"}>
          {next && <div>下一次：{D.fmtSmart(next)}</div>}
          {last && <div>最后一次：{D.fmtSmart(last)}</div>}
          {rep.end && !last && <div>已无后续</div>}
        </div>
      )}
    </>
  );
}
