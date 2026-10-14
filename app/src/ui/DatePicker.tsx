/**
 * DatePicker —— 自定义日期选择器（替代原生 `<input type="date">`）
 *
 * 一个日期按钮 + 一个月历浮层 + 一个清除。
 *
 * **没有「今天 / 明天 / 后天 / 大后天」快捷键**（2026-10-09 去掉）：日程是
 * 「选出来的」不是「猜出来的」，那四个格子只覆盖极少数情况，却让控件从一行
 * 变成三行、把真正的月历挤到第二屏。要「明天」的人翻一页月历就是一下。
 */

import { useRef, useState } from 'react';
import * as D from '../domain/date.ts';
import { MiniCalendar } from './MiniCalendar.tsx';
import { useAnchoredPosition, useOutsideClose, useEscape } from './hooks.ts';

export function DatePicker({ value, onChange }: {
  /** 当前日期 'YYYY-MM-DD'，null = 待定 */
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchor, panel, open);
  const [view, setView] = useState(() => {
    const iso = value || D.today();
    const [y, m] = iso.split('-').map(Number);
    return { y, m };
  });

  /* 点外面 / Esc 关掉。anchor 就是开关按钮本身，必须当 trigger 传 ——
     不传的话 mousedown 先关、click 又翻回来，按钮就再也关不掉了。 */
  useOutsideClose(panel, open, () => setOpen(false), anchor);
  useEscape(open, () => setOpen(false));

  const today = D.today();

  return (
    <div className="dp">
      <button
        ref={anchor}
        className={'dp-btn' + (value ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={"dp-label"}>{value ? D.fmtSmart(value) : '选日期'}</span>
        {value && <span className={"dp-x"} aria-label="清除日期" onClick={(e) => { e.stopPropagation(); onChange(null); }}>✕</span>}
      </button>
      {open && (
        <div
          ref={panel}
          className="dp-pop"
          style={{
            top: pos ? pos.top : 0,
            left: pos ? pos.left : 0,
            // 量之前先藏起来，免得在左上角闪一帧
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <MiniCalendar
            month={`${view.y}-${String(view.m).padStart(2, '0')}-01`}
            value={value}
            todayIso={today}
            loadOf={() => 0}
            onMonth={(iso) => {
              const [y, m] = iso.split('-').map(Number);
              setView({ y, m });
            }}
            onPick={(iso) => { onChange(iso); setOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}
