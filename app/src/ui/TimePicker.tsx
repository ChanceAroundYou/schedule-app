/**
 * TimePicker —— 自定义时间选择器（替代原生 `<input type="time">`）
 *
 * 一个时间按钮 + 一个 12 小时制转盘 + 一个清除。选完分钟转盘自己收起。
 *
 * **没有 09:00 / 12:00 / 15:00 / 18:00 快捷格**（2026-10-09 去掉）：同
 * DatePicker 的理由 —— 四个格子覆盖不到的时刻才是多数，而它们让控件从一行
 * 变成三行。拨表盘本来就是点两下的事。
 */

import { useState } from 'react';
import { ClockBody } from './Clock.tsx';

export function TimePicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tp">
      <div className="tp-cur">
        <button className={'tp-btn' + (value ? ' on' : '')} onClick={() => setOpen((v) => !v)}>
          {value || '选时间'}
        </button>
        {value && <button className="tp-clear" onClick={() => onChange(null)}>✕</button>}
      </div>
      {open && (
        <div className="tp-dial">
          {/* 分钟一落定 = 这次选择走完了 → 收起（跟快速添加那层面板同一套语义） */}
          <ClockBody value={value} face={198} onChange={(v) => onChange(v)} onMinutePick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
