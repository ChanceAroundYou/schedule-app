/**
 * SheetPicker —— Sheet 选择器
 */

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../cx.ts';
import { Btn } from './Btn.tsx';
import { Sheet } from './Sheet.tsx';

/**
 * 动态 / 大选项集的选择器：一个按钮，点开是 Sheet 浮层。
 *
 * 用于选项数量不固定（如项目列表）或选项较多的场合。
 * 小选项集（≤ 7 个固定选项）用 Chips 更直接。
 */
export function SheetPicker<K extends string>({ value, options, onPick, label, labelledBy }: {
  value: K;
  options: readonly { value: K; label: string }[];
  onPick: (v: K) => void;
  label: string;
  /** 有可见标签时指向那个标签元素的 id（浮层标题仍用 label） */
  labelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Btn variant="chip" onClick={() => setOpen(true)} aria-label={label} aria-labelledby={labelledBy}>
        {current?.label || '选择…'}
        <ChevronDown size={14} />
      </Btn>
      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <div className="flex flex-col gap-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onPick(o.value); setOpen(false); }}
              className={cx(
                'flex items-center justify-between rounded-[var(--r-md)] px-3 py-2.5 text-left text-[13.5px] transition',
                o.value === value
                  ? 'bg-[var(--primary-soft)] font-medium text-[var(--primary)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--panel-3)]',
              )}
            >
              {o.label}
              {o.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
