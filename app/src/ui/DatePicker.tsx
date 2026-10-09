/**
 * DatePicker —— 自定义日期选择器（替代原生 `<input type="date">`）
 *
 * 三档：快捷日期（今天/明天/后天/大后天）→ 自定义日期面板 → 清除。
 * 面板用月视图网格，和「找日期」的 `.jump-pop` 同一套交互。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as D from '../domain/date.ts';

const QUICK = [
  { value: 0, label: '今天' },
  { value: 1, label: '明天' },
  { value: 2, label: '后天' },
  { value: 3, label: '大后天' },
];

export function DatePicker({ value, onChange, plain = false }: {
  /** 当前日期 'YYYY-MM-DD'，null = 待定 */
  value: string | null;
  onChange: (v: string | null) => void;
  /** **只要那个日期按钮**，不要「今天 / 明天 / 后天 / 大后天」快捷键，也不要清除。
   *  重复规则的「到某天」用的就是这一档：结束日期只有「在起始日之后」一种
   *  取值方向，给它摆「今天 / 明天」等于暗示「从今天起」。 */
  plain?: boolean;
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
      {!plain && (
        <div className="dp-quick">
          {QUICK.map((q) => {
            const iso = D.addDays(today, q.value);
            const on = value === iso;
            return (
              <button
                key={q.value}
                className={'dp-q' + (on ? ' on' : '')}
                onClick={() => onChange(iso)}
              >{q.label}</button>
            );
          })}
        </div>
      )}
      <div className="dp-cur">
        <button
          ref={anchor}
          className={'dp-btn' + (value ? ' on' : '')}
          onClick={() => setOpen((v) => !v)}
        >
          {value ? D.fmtMD(value) : '选日期'}
        </button>
        {value && !plain && (
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
