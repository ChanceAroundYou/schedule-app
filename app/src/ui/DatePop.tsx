/**
 * DatePop —— 快速添加里「先选日期」那一层的迷你日历
 *
 * 从 JumpPop 里把「月历格子」抽出来两处共用（`MiniCalendar`），
 * 免得同一个日历出现两份实现、改一处漏一处。
 *
 * **定位照抄 ClockPop**：`position: fixed` + 按 anchor 实算，下方放不下就翻到
 * 上面、右边超出就往左收。不新造一套定位逻辑。
 *
 * 与 JumpPop 的差别只有三点：
 *   1. 没有文本输入框（那是「找日期」专用的自然语言解析，快速添加用不上）；
 *   2. 多一个「不选日期」—— 待办箱的默认就是无日期，得给一条「保持无日期」
 *      的路，否则用户点开面板只能选一个日期、回不去；
 *   3. 选完日期**不关面板**，而是交给调用方进第二层（时间转盘）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as D from '../domain/date.ts';

export interface MiniCalendarProps {
  /** 当前显示月份的 1 号 */
  month: string;
  /** 高亮哪个格子（默认值 / 已选值）。null = 不高亮 */
  value: string | null;
  /** 给「今天」描边 */
  todayIso: string;
  /** 那天的未完成数，画淡底 + 底部短横（口径由调用方给，两处共用同一份） */
  loadOf: (iso: string) => number;
  /** 翻月 */
  onMonth: (iso: string) => void;
  /** 点某天 */
  onPick: (iso: string) => void;
}

export function MiniCalendar({ month, value, todayIso, loadOf, onMonth, onPick }: MiniCalendarProps) {
  const days = D.monthMatrix(month);
  const curMonth = D.parseISO(month).getMonth();
  return (
    <>
      <div className="jp-head">
        <button className="jp-nav" title="上个月" onClick={() => onMonth(D.addMonths(month, -1))}>
          <ChevronLeft size={14} />
        </button>
        <span className="jp-label">
          {D.parseISO(month).getFullYear()} 年 {D.parseISO(month).getMonth() + 1} 月
        </span>
        <button className="jp-nav" title="下个月" onClick={() => onMonth(D.addMonths(month, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="jp-week">
        <span>一</span><span>二</span><span>三</span><span>四</span>
        <span>五</span><span>六</span><span>日</span>
      </div>

      <div className="jp-grid">
        {days.map((d) => {
          const out = D.parseISO(d).getMonth() !== curMonth;
          const n = loadOf(d);
          // 类名对不上等于没写：CSS 里是 `.jp-cell`，不是 `.jp-day`
          return (
            <button
              // 日期密度用**淡底 + 底部短横**，不用圆点 —— 圆点在 1x 屏上几乎看不见
              className={'jp-cell' + (out ? ' out' : '')
                + (d === todayIso ? ' today' : '')
                + (d === value ? ' cur' : '')
                + (n ? ' has' + (n >= 6 ? ' lv3' : n >= 3 ? ' lv2' : '') : '')}
              key={d}
              data-jump={d}
              title={D.fmtFull(d) + ' · ' + (n ? n + ' 项待办' : '空闲')}
              onClick={() => onPick(d)}
            >{D.parseISO(d).getDate()}</button>
          );
        })}
      </div>
    </>
  );
}

export interface DatePopProps {
  open: boolean;
  /** 弹层贴着哪个元素出现。为空就不渲染 */
  anchor: HTMLElement | null;
  /** 默认 / 已选日期。null = 没有默认（待办箱那种） */
  value: string | null;
  todayIso: string;
  loadOf: (iso: string) => number;
  /** 选了某天 → 进第二层 */
  onPick: (iso: string) => void;
  /** 「不选日期」→ 进第二层，但日期留空 */
  onClear: () => void;
  /** 点外 / Esc → 整条取消 */
  onClose: () => void;
}

export function DatePop({ open, anchor, value, todayIso, loadOf, onPick, onClear, onClose }: DatePopProps) {
  const box = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => D.monthStart(value || todayIso));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* 打开时把月份拨到默认值所在的月 —— 待办箱那种 null 就拨到今天 */
  useEffect(() => {
    if (open) setMonth(D.monthStart(value || todayIso));
  }, [open, value, todayIso]);

  /* 定位要在 useLayoutEffect 里量：放到 useEffect 会先画在左上角再跳过来 */
  useLayoutEffect(() => {
    if (!open || !anchor || !box.current) { setPos(null); return; }
    const r = anchor.getBoundingClientRect();
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    let top = r.bottom + 6;
    let left = r.left;
    // 下方放不下就翻到上面；右边超出就往左收。都留 8px 边距
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    setPos({ top, left });
  }, [open, anchor, month]);

  /* 点外面关掉 / Esc 关掉。Esc 要 stopImmediatePropagation ——
     否则 App 那层的 Esc 会跟着再关一次抽屉 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t)) return;
      if (anchor?.contains(t)) return;   // 点按钮本身由按钮自己 toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;

  return (
    <div
      className="date-pop"
      ref={box}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        // 量之前先藏起来，免得在左上角闪一帧
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <MiniCalendar
        month={month}
        value={value}
        todayIso={todayIso}
        loadOf={loadOf}
        onMonth={setMonth}
        onPick={onPick}
      />
      <div className="dp-foot">
        <button className="ghost-btn" onClick={onClear}>不选日期</button>
        <span className="grow" />
        <button className="ghost-btn" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
