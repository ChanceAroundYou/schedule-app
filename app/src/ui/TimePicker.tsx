/**
 * TimePicker —— 自定义时间选择器（替代原生 `<input type="time">` + 时钟按钮浮层）
 *
 * 快捷 Chips（常用时间）→ ClockBody 表盘（内嵌，不用浮层）→ 清除。
 * 表盘用 ClockBody，face 调小到 198px 适配抽屉宽度。
 */

import { useState } from 'react';
import { ClockBody } from './Clock.tsx';

const QUICK = [
  { value: '09:00', label: '上午 9:00' },
  { value: '12:00', label: '中午 12:00' },
  { value: '15:00', label: '下午 3:00' },
  { value: '18:00', label: '下午 6:00' },
];

export function TimePicker({ value, onChange }: {
  /** 当前时间 'HH:MM'，null = 不限 */
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [custom, setCustom] = useState(false);

  return (
    <div className="tp">
      <div className="tp-quick">
        {QUICK.map((q) => {
          const on = value === q.value;
          return (
            <button
              key={q.value}
              className={'tp-q' + (on ? ' on' : '')}
              onClick={() => onChange(q.value)}
            >{q.label}</button>
          );
        })}
        <button
          className={'tp-q' + (custom ? ' on' : '')}
          onClick={() => setCustom((v) => !v)}
        >{value && !QUICK.some((q) => q.value === value) ? value : '其他'}</button>
      </div>
      {custom && (
        <div className="tp-dial">
          <ClockBody
            value={value}
            face={198}
            onChange={(v) => onChange(v)}
            onMinutePick={() => setCustom(false)}
          />
        </div>
      )}
      {value && !custom && (
        <button className="tp-clear" onClick={() => onChange(null)}>✕</button>
      )}
    </div>
  );
}
