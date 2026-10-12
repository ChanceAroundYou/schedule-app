/**
 * Dropdown —— 自定义下拉选择器
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cx } from '../cx.ts';
import { useOutsideClose } from '../hooks.ts';

export interface DropdownOption<K extends string | number> {
  value: K;
  label: string;
  disabled?: boolean;
}

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, string> = {
  sm: 'h-[30px] px-2.5 text-[12.5px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[15px]',
};

/**
 * 自定义下拉选择器：不用原生 <select>，也不依赖浏览器默认菜单。
 *
 * 适合需要节省横向空间、但选项数量不适合铺成 Chips 的场合。
 * `renderValue` / `renderOption` 可插入色点、图标等内容，`className`、
 * `menuClassName` 留给调用方接入同一套令牌下的尺寸和强调色。
 */
export function Dropdown<K extends string | number>({
  value,
  options,
  onPick,
  label,
  labelledBy,
  placeholder = '选择…',
  disabled = false,
  size = 'md',
  className,
  menuClassName,
  renderValue,
  renderOption,
}: {
  value: K | null;
  options: readonly DropdownOption<K>[];
  onPick: (value: K) => void;
  label: string;
  labelledBy?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: Size;
  className?: string;
  menuClassName?: string;
  /** 触发按钮上画当前值。**`option` 可能是 undefined** —— 当前值不在
      options 里时（比如 owner：它不是能分下去的权限，就不在下拉里）。
      传了 renderValue 就以它为准，没传才回退到选项文字 / placeholder。 */
  renderValue?: (option: DropdownOption<K> | undefined) => ReactNode;
  renderOption?: (option: DropdownOption<K>, selected: boolean) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const current = options.find((o) => o.value === value);
  const enabled = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !option.disabled);

  useOutsideClose(root, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const selected = options.findIndex((option) => option.value === value && !option.disabled);
    setActive(selected >= 0 ? selected : (enabled[0]?.index ?? -1));
  }, [open, options, value]);

  const pick = (option: DropdownOption<K>) => {
    if (option.disabled) return;
    onPick(option.value);
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };

  const move = (direction: 1 | -1) => {
    if (!enabled.length) return;
    const currentIndex = enabled.findIndex(({ index }) => index === active);
    const next = enabled[(currentIndex + direction + enabled.length) % enabled.length];
    setActive(next.index);
  };

  return (
    <div ref={root} className="relative inline-block min-w-0">
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
            move(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            if (open && active >= 0) {
              event.preventDefault();
              const option = options[active];
              if (option) pick(option);
            }
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className={cx(
          'inline-flex min-w-0 items-center justify-between gap-2 rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] text-[var(--text)] outline-none transition',
          'hover:border-[var(--primary)] focus:border-[var(--primary)] focus:bg-[var(--panel)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          SIZE[size],
          className,
        )}
      >
        <span className="min-w-0 truncate text-left">
          {renderValue ? renderValue(current) : (current ? current.label : placeholder)}
        </span>
        <ChevronDown size={14} aria-hidden="true" className={cx('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className={cx(
            // `w-max` 而不是只 `min-w-full`：面板是绝对定位的，宽度走
            // shrink-to-fit —— 触发按钮窄的时候（成员行那个角色选择器只有
            // 78px），面板会被压到触发按钮那么窄，于是「可编辑」竖着断成
            // 两行（实测 option 高 53px = 两行）。`w-max` 让它按内容撑开，
            // 再 `min-w-full` 保证不比触发按钮窄。选项文字同时加
            // `whitespace-nowrap`，双保险。
            'absolute left-0 top-[calc(100%+4px)] z-[60] max-h-64 w-max min-w-full overflow-y-auto rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel)] p-1 shadow-lg',
            menuClassName,
          )}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={String(option.value)}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onMouseEnter={() => !option.disabled && setActive(index)}
                onClick={() => pick(option)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-[13px] transition',
                  selected
                    ? 'bg-[var(--primary-soft)] text-[var(--primary)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]',
                  active === index && !selected && 'bg-[var(--panel-3)]',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                <span className="min-w-0 flex-1 whitespace-nowrap">{renderOption ? renderOption(option, selected) : option.label}</span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
