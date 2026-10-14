/**
 * TimePicker —— 自定义时间选择器（替代原生 `<input type="time">`）
 *
 * 一个时间按钮 + 一个 24 小时制转盘 + 一个清除。选完分钟转盘自己收起。
 *
 * **没有 09:00 / 12:00 / 15:00 / 18:00 快捷格**（2026-10-09 去掉）：同
 * DatePicker 的理由 —— 四个格子覆盖不到的时刻才是多数，而它们让控件从一行
 * 变成三行。拨表盘本来就是点两下的事。
 */

import { useRef, useState } from 'react';
import { ClockBody } from './Clock.tsx';
import { useAnchoredPosition, useOutsideClose, useEscape } from './hooks.ts';

export function TimePicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchor, panel, open);

  /* 同 DatePicker：anchor 既是开关又是定位基准，必须当 trigger 传，
     否则 mousedown 先关、click 又翻回来。 */
  useOutsideClose(panel, open, () => setOpen(false), anchor);
  useEscape(open, () => setOpen(false));

  return (
    <div className="tp">
      <button ref={anchor} type="button" aria-label={value ? `时间 ${value}` : '选择时间'} className={'tp-btn' + (value ? ' on' : '')} onClick={() => setOpen((v) => !v)}>
        <span className={"tp-label"}>{value || '选时间'}</span>
        {value && <span className="tp-x" aria-label="清除时间" onClick={(e) => { e.stopPropagation(); onChange(null); }}>✕</span>}
      </button>
      {open && (
        <div ref={panel} className="tp-dial" role="dialog" aria-label="选择时间" style={{ top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden' }}>
          <ClockBody value={value} face={198} onChange={(v) => onChange(v)} onMinutePick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
