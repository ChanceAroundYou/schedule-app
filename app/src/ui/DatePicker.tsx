/**
 * DatePicker —— 自定义日期选择器（替代原生 `<input type="date">`）
 *
 * 一个日期按钮 + 一个月历浮层 + 一个清除。
 *
 * **没有「今天 / 明天 / 后天 / 大后天」快捷键**（2026-10-09 去掉）：日程是
 * 「选出来的」不是「猜出来的」，那四个格子只覆盖极少数情况，却让控件从一行
 * 变成三行、把真正的月历挤到第二屏。要「明天」的人翻一页月历就是一下。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as D from '../domain/date.ts';

export function DatePicker({ value, onChange }: {
  /** 当前日期 'YYYY-MM-DD'，null = 待定 */
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [view, setView] = useState(() => {
    const iso = value || D.today();
    const [y, m] = iso.split('-').map(Number);
    return { y, m };
  });

  /* 面板定位 */
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) { setPos(null); return; }
    const r = anchor.current.getBoundingClientRect();
    const w = panel.current.offsetWidth;
    const h = panel.current.offsetHeight;
    let top = r.bottom + 6;
    let left = r.left;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    setPos({ top, left });
  }, [open]);

  /* 点外面关掉 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t)) return;
      if (anchor.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const today = D.today();
  const grid = D.monthMatrix(`${view.y}-${String(view.m).padStart(2, '0')}-01`);

  return (
    <div className="dp">
      <div className="dp-cur">
        <button
          ref={anchor}
          className={'dp-btn' + (value ? ' on' : '')}
          onClick={() => setOpen((v) => !v)}
        >
          {value ? D.fmtMD(value) : '选日期'}
        </button>
        {value && (
          <button className="dp-clear" onClick={() => onChange(null)}>✕</button>
        )}
      </div>
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
          <div className="dp-nav">
            <button
              className="dp-nav-btn"
              onClick={() => setView((v) => {
                const m = v.m - 1;
                return m < 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m };
              })}
            >‹</button>
            <span className="dp-nav-label">{view.y} 年 {view.m} 月</span>
            <button
              className="dp-nav-btn"
              onClick={() => setView((v) => {
                const m = v.m + 1;
                return m > 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m };
              })}
            >›</button>
          </div>
          <div className="dp-week">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => <span key={w}>{w}</span>)}
          </div>
          <div className="dp-grid">
            {grid.map((iso) => {
              const d = Number(iso.split('-')[2]);
              const inMonth = iso.startsWith(`${view.y}-${String(view.m).padStart(2, '0')}`);
              const on = value === iso;
              const isToday = iso === today;
              return (
                <button
                  key={iso}
                  className={
                    'dp-cell'
                    + (on ? ' on' : '')
                    + (isToday ? ' today' : '')
                    + (!inMonth ? ' out' : '')
                  }
                  onClick={() => { onChange(iso); setOpen(false); }}
                >{d}</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
