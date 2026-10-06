/**
 * ClockPop —— 12 小时制时间转盘
 *
 * 这是从旧版 `legacy/clock.js` 移植过来的，重构时丢过一次。
 *
 * **为什么不直接用原生 `<input type="time">`**：那个控件在手机上确实好用，
 * 但在桌面上，一个嵌入式的时间输入框要点开系统控件才能改，而要改的往往只是
 * 「把 9 点挪到 10 点」这种一格的事。这个转盘一次点击就够，还有
 * 「现在 / 清除」两个高频动作。
 *
 * 表盘按**真实时钟的画法**：12 在顶部，顺时针 1→11，再靠上面的「上午 / 下午」
 * 区分两圈。比 24 小时制的一圈 24 个数好用 —— 一圈 24 个数每个 . 只有 15°，
 * 手指粗细的量级，必然点不准。
 *
 * 分钟那档是 12 个数（每 5 分钟一格）。**不做逐分钟**：这个应用的时间轴
 * 最小步进是 15 分钟（拖拽、拉伸都按这个档），给到 1 分钟的精度没有意义，
 * 只会让用户在上面戳半天。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as D from '../domain/date.ts';

const C = 123;   // 表盘中心（= .cp-face 的 246px 的一半）
const R = 94;    // 数字环半径

export interface ClockPopProps {
  open: boolean;
  /** 弹层贴着哪个元素出现。为空就不渲染 */
  anchor: HTMLElement | null;
  /** 当前值 'HH:MM'，null = 未定时 */
  value: string | null;
  /** 点「确定」回传 'HH:MM'，点「清除」回传 null */
  onChange: (v: string | null) => void;
  onClose: () => void;
}

export function ClockPop({ open, anchor, value, onChange, onClose }: ClockPopProps) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'h' | 'm'>('h');
  const [hour, setHour] = useState(9);    // 内部一律 24 小时制
  const [minute, setMinute] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* 打开时按当前值复位。没有值时给**当前整点**而不是 09:00 ——
     「新建一件现在要做的事」比「早上九点要做的事」常见得多 */
  useEffect(() => {
    if (!open) return;
    const m = D.timeToMin(value);
    if (m == null) { const n = D.nowMin(); setHour(Math.floor(n / 60)); setMinute(0); }
    else { setHour(Math.floor(m / 60)); setMinute(m % 60); }
    setMode('h');
  }, [open, value]);

  /* 定位要在 useLayoutEffect 里量：放到 useEffect 会先画在左上角再跳过来，
     窄屏那一帧的闪动很明显 */
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
  }, [open, anchor, mode, hour, minute]);

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

  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const isAm = hour < 12;
  const isHour = mode === 'h';

  // 选小时时画 12,1,2…11；选分钟时画 0,5,10…55
  const list = isHour
    ? Array.from({ length: 12 }, (_, k) => (k === 0 ? 12 : k))
    : Array.from({ length: 12 }, (_, j) => j * 5);
  const cur = isHour ? h12 : minute;
  const idx = isHour ? (h12 === 12 ? 0 : h12) : Math.round(minute / 5) % 12;
  const ang = (idx / 12) * 360 - 90;

  const pick = (v: number) => {
    if (isHour) {
      const base = v % 12;                       // 12→0，其余→v
      setHour(base + (isAm ? 0 : 12));
      setMode('m');                              // 选完小时自动进分钟档
    } else {
      setMinute(v);
    }
  };

  const setAmPm = (am: boolean) => {
    setHour((hour % 12) + (am ? 0 : 12));
  };

  const commit = () => { onChange(D.pad(hour) + ':' + D.pad(minute)); onClose(); };
  const clear = () => { onChange(null); onClose(); };

  return (
    <div
      className="clock-pop"
      ref={box}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        // 量之前先藏起来，免得在左上角闪一帧
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="cp-ampm">
        <button className={'cp-ap' + (isAm ? ' on' : '')} onClick={() => setAmPm(true)}>上午</button>
        <button className={'cp-ap' + (!isAm ? ' on' : '')} onClick={() => setAmPm(false)}>下午</button>
      </div>

      <div className="cp-display">
        <button className={'cp-cell' + (isHour ? ' active' : '')} onClick={() => setMode('h')}>
          {D.pad(h12)}
        </button>
        <span className="cp-colon">:</span>
        <button className={'cp-cell' + (!isHour ? ' active' : '')} onClick={() => setMode('m')}>
          {D.pad(minute)}
        </button>
      </div>

      <div className="cp-face">
        <i className="cp-hand" style={{ width: R + 'px', transform: `rotate(${ang}deg)` }} />
        <span className="cp-dot" />
        {list.map((v, k) => {
          const a = ((k / 12) * 360 - 90) * Math.PI / 180;
          return (
            <button
              className={'cp-num' + (v === cur ? ' on' : '')}
              key={v}
              style={{ left: (C + R * Math.cos(a)) + 'px', top: (C + R * Math.sin(a)) + 'px' }}
              onClick={() => pick(v)}
            >{isHour ? v : D.pad(v)}</button>
          );
        })}
      </div>

      <div className="cp-tip">
        {isHour ? '选小时（12 在顶部，配合上方上午 / 下午）' : '选分钟，每格 5 分钟'}
      </div>

      <div className="cp-foot">
        <button
          className="chip tiny"
          onClick={() => { const n = D.nowMin(); setHour(Math.floor(n / 60)); setMinute(n % 60); }}
        >现在</button>
        <button className="chip tiny" onClick={clear}>清除</button>
        <span className="grow" />
        <button className="ghost-btn" onClick={onClose}>取消</button>
        <button className="primary-btn" onClick={commit}>确定</button>
      </div>
    </div>
  );
}
