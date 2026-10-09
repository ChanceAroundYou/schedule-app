/**
 * WheelPicker —— iOS 风格滚轮选择器。
 * 两个滚轮并排，选中的项高亮，下方内容跟着变。
 */
import { useRef, useState, useEffect } from 'react';

export interface WheelOption {
  value: string;
  label: string;
}

export interface WheelPickerProps {
  leftOptions: WheelOption[];
  rightOptions: WheelOption[];
  leftValue: string;
  rightValue: string;
  onLeftChange: (v: string) => void;
  onRightChange: (v: string) => void;
  leftLabel?: string;
  rightLabel?: string;
}

export function WheelPicker({
  leftOptions,
  rightOptions,
  leftValue,
  rightValue,
  onLeftChange,
  onRightChange,
  leftLabel,
  rightLabel,
}: WheelPickerProps) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [leftIdx, setLeftIdx] = useState(() => {
    const i = leftOptions.findIndex((o) => o.value === leftValue);
    return i >= 0 ? i : 0;
  });
  const [rightIdx, setRightIdx] = useState(() => {
    const i = rightOptions.findIndex((o) => o.value === rightValue);
    return i >= 0 ? i : 0;
  });

  useEffect(() => {
    const i = leftOptions.findIndex((o) => o.value === leftValue);
    if (i >= 0 && i !== leftIdx) setLeftIdx(i);
  }, [leftValue, leftOptions, leftIdx]);

  useEffect(() => {
    const i = rightOptions.findIndex((o) => o.value === rightValue);
    if (i >= 0 && i !== rightIdx) setRightIdx(i);
  }, [rightValue, rightOptions, rightIdx]);

  const scrollTo = (ref: { current: HTMLDivElement | null }, idx: number) => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[idx + 1] as HTMLElement; // +1 跳过第一个 spacer
    if (item) {
      el.scrollTo({ top: item.offsetTop - el.offsetHeight / 2 + item.offsetHeight / 2, behavior: 'smooth' });
    }
  };

  useEffect(() => { scrollTo(leftRef, leftIdx); }, [leftIdx]);
  useEffect(() => { scrollTo(rightRef, rightIdx); }, [rightIdx]);

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 滚动停了（80ms 没再滚）才读最终位置。点一个项会触发平滑滚动，滚动途中
     连续 onScroll —— 那些中间值会把选择往回带，所以必须等停。取第一个 item
     的高度（children[1]，不是 children[0] 那个 spacer），scrollTop 是 item
     顶相对容器顶的距离，居中后正好是 idx × itemH。 */
  const handleScroll = (ref: { current: HTMLDivElement | null }, idx: number, setIdx: (i: number) => void, options: WheelOption[], onChange: (v: string) => void) => {
    const el = ref.current;
    if (!el) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const itemH = (el.children[1] as HTMLElement)?.offsetHeight || 32;
      const i = Math.round(el.scrollTop / itemH);
      const clamped = Math.max(0, Math.min(options.length - 1, i));
      if (clamped !== idx) {
        setIdx(clamped);
        onChange(options[clamped].value);
      }
    }, 80);
  };

  const renderWheel = (
    ref: { current: HTMLDivElement | null },
    options: WheelOption[],
    idx: number,
    setIdx: (i: number) => void,
    onChange: (v: string) => void,
    label?: string,
  ) => (
    <div className="wp-wheel-col">
      {label && <div className="wp-wheel-label">{label}</div>}
      <div
        className="wp-wheel"
        ref={ref}
        onScroll={() => handleScroll(ref, idx, setIdx, options, onChange)}
      >
        <div className="wp-wheel-spacer" />
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            value={o.value}
            className={'wp-wheel-item' + (i === idx ? ' on' : '')}
            onClick={() => {
              setIdx(i);
              onChange(o.value);
              scrollTo(ref, i);
            }}
          >{o.label}</button>
        ))}
        <div className="wp-wheel-spacer" />
      </div>
    </div>
  );

  return (
    <div className="wp-picker">
      {renderWheel(leftRef, leftOptions, leftIdx, setLeftIdx, onLeftChange, leftLabel)}
      {renderWheel(rightRef, rightOptions, rightIdx, setRightIdx, onRightChange, rightLabel)}
    </div>
  );
}
