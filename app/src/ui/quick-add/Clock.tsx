/**
 * ClockBody —— 24 小时制时间转盘。
 * 小时分成内圈 0–11、外圈 12–23；分钟仍是每 5 分钟一格。
 */
import { useState } from 'react';
import * as D from '../../domain/date.ts';

const FACE_POP = 246;
const R_INSET = 18;
const RING_GAP = 24;

export interface ClockBodyProps {
  value: string | null;
  face?: number;
  onChange: (v: string) => void;
  onMinutePick?: () => void;
}

export function ClockBody({ value, face = FACE_POP, onChange, onMinutePick }: ClockBodyProps) {
  const init = D.timeToMin(value);
  const [mode, setMode] = useState<'h' | 'm'>('h');
  const [hour, setHour] = useState(() => init == null ? Math.floor(D.nowMin() / 60) : Math.floor(init / 60));
  const [minute, setMinute] = useState(() => init == null ? 0 : init % 60);
  const C = face / 2;
  const R = face / 2 - R_INSET;
  const isHour = mode === 'h';
  const nowMin = D.nowMin();
  const isNow = hour === Math.floor(nowMin / 60) && minute === nowMin % 60;
  const emit = (h: number, mi: number) => onChange(D.pad(h) + ':' + D.pad(mi));
  const pick = (k: number, ring: 'inner' | 'outer' = 'inner') => {
    if (isHour) {
      const h = ring === 'outer' ? k + 12 : k;
      setHour(h);
      emit(h, minute);
      setMode('m');
    } else {
      const mi = k * 5;
      setMinute(mi);
      emit(hour, mi);
      onMinutePick?.();
    }
  };
  const now = () => {
    const n = D.nowMin();
    const h = Math.floor(n / 60), mi = n % 60;
    setHour(h); setMinute(mi); emit(h, mi); onMinutePick?.();
  };
  const curHour = hour % 12;
  const curK = isHour ? curHour : Math.round(minute / 5) % 12;
  const ang = (curK / 12) * 360 - 90;
  const handLen = isHour ? (hour >= 12 ? R : R - RING_GAP) : R;
  const ring = (radius: number, kind: 'inner' | 'outer') => Array.from({ length: 12 }, (_, k) => {
    const a = ((k / 12) * 360 - 90) * Math.PI / 180;
    const selected = isHour && curHour === k && (kind === 'outer' ? hour >= 12 : hour < 12);
    return (
      <button
        type="button"
        className={'cp-num cp-' + kind + (selected || (!isHour && k === curK) ? ' on' : '')}
        key={kind + k}
        style={{ left: (C + radius * Math.cos(a)) + 'px', top: (C + radius * Math.sin(a)) + 'px' }}
        onClick={() => pick(k, kind)}
      >{isHour ? (kind === 'outer' ? k + 12 : k) : k * 5}</button>
    );
  });

  return (
    <>
      <div className={"cp-tools"}>
        <button type="button" className={'cp-now' + (isNow ? ' on' : '')} onClick={now}>现在</button>
      </div>
      <div className={'cp-face ' + (mode === 'h' ? "cp-h" : "cp-m")} style={{ width: face + 'px', height: face + 'px' }}>
        <i className={"cp-hand"} style={{ width: handLen + 'px', transform: `rotate(${ang}deg)` }} />
        <button type="button" className={'cp-dot' + (isHour ? ' h' : ' ' + "m")} title={isHour ? '切到分钟' : '切到小时'} aria-label={isHour ? '切到分钟' : '切到小时'} onClick={() => setMode(isHour ? 'm' : 'h')}>{isHour ? '时' : '分'}</button>
        {isHour ? <>{ring(R - RING_GAP, 'inner')}{ring(R, 'outer')}</> : ring(R, 'inner')}
      </div>
    </>
  );
}
