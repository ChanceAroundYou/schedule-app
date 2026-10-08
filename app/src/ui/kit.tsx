/**
 * kit.tsx —— 应用内浮层与提示
 *
 * 存在的理由只有一条：**原生 confirm() / alert() / prompt() 在 PWA 里会被
 * 静默吞掉**（直接返回 false）。旧版就用原生 confirm，装成 App 之后
 * 表现是「点了删除完全没反应」，用户看不到任何提示，代码却以为他点了取消。
 *
 * 所以这里不导出任何原生对话框的包装 —— 要确认就走 useConfirm() 的 Promise，
 * 要提示就走 toast()。全应用没有第二套。
 *
 * 不再把原生 `<select>` 当作组件库基础。所有选择控件使用 `Dropdown`、`Chips` 或 `SheetPicker`。
 */

import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ReactNode, type ButtonHTMLAttributes, type RefObject,
  type InputHTMLAttributes, type TextareaHTMLAttributes,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { cx } from './cx.ts';
import { useFocusTrap, useOutsideClose } from './hooks.ts';

/* ================================ 按钮 ================================ */

/* 五种固定 variant，覆盖全应用所有按钮场景：
   primary  主操作（保存、确认、跳转）
    normal  普通操作（导航、切换、取消）
    ghost   极轻操作（关闭、清空）
    danger  危险操作（删除、退出）
    chip    标签式操作（筛选、选择）
   新增 variant 必须先在这里加，再在 语义样式模块 里加对应样式 —— 别在
   .tsx 里写死颜色，那等于把设计令牌绕过去。 */
type Variant = 'primary' | 'normal' | 'ghost' | 'danger' | 'chip';

/* 变量名一律写 语义样式模块 里**真实存在**的那些，且**不给兜底值**。
   兜底值看着稳，其实是把「变量名写错了」变成静默降级：这里原先写的是
   --accent / --card / --line / --chip / --hover / --accent-soft 那一批，
   而 --accent / --accent-soft / --card / --chip / --hover / --line
   在 语义样式模块 里**一个都没有** —— 于是两套主题下全是写死的颜色，
   主按钮那个 #4f7cff 压白字只有 3.70:1，暗色也没跟着 --primary 走。
   没有兜底值时写错名字会当场看得见（声明失效→继承），不会悄悄糊过去。
   tests/contrast.mjs 末尾有一条扫描锁着这件事。 */
const VARIANT: Record<Variant, string> = {
  primary: 'bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-95 active:brightness-90',
  normal: 'border-[var(--border-w)] border-[var(--input)] bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] hover:border-[var(--text-3)]',
  ghost: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)]',
  danger: 'border-[var(--border-w)] border-[var(--danger)] bg-transparent text-[var(--danger)] hover:bg-[var(--danger-soft)]',
  chip: 'border-[var(--border-w)] border-[var(--input)] bg-[var(--panel)] text-[var(--text-2)] hover:border-[var(--primary)] hover:text-[var(--primary)]',
};

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[15px]',
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { variant = 'normal', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx(
        'btn inline-flex items-center justify-center gap-1.5 rounded-[var(--r-md)] font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
    />
  );
});

/* ================================ 表单控件 ================================ */

/* 输入框 / 文本域统一走这两个组件。
   样式全部引用 语义样式模块 的设计令牌（--input / --border-w / --r-md /
   --panel-2 / --primary），不在 .tsx 里写死颜色。
   需要特殊尺寸时用 className 覆盖，不要在组件里加 variant。 */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  dense?: boolean;
}

export function Input({ dense, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={cx(
        'w-full rounded-[var(--r-md)] border-[var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none transition',
        dense && 'h-[30px] w-auto px-2 text-[12.5px]',
        'focus:border-[var(--primary)] focus:bg-[var(--panel)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    />
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...rest }, ref) => {
    return (
      <textarea
        ref={ref}
        {...rest}
        className={cx(
          'w-full rounded-[var(--r-md)] border-[var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none transition',
          'focus:border-[var(--primary)] focus:bg-[var(--panel)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
    );
  }
);

/* =============================== 底部浮层 =============================== */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** 面板底部固定的一排按钮 */
  footer?: ReactNode;
  /** 点遮罩是否关闭。确认类浮层通常设 false，逼用户做出选择 */
  dismissable?: boolean;
}

/**
 * 移动端风格的底部浮层，宽屏下变成居中卡片。
 *
 * z-index 必须压过底部标签栏（45）—— 否则抽屉会被标签栏盖住一截。
 */
export function Sheet({ open, onClose, title, children, footer, dismissable = true }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const tid = useId();
  useOutsideClose(panel, open && dismissable, onClose);
  useFocusTrap(panel, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);

  /* 焦点送进面板本身而不是第一个按钮 —— 见 Drawer.tsx 里那段：送进控件
     会顺手把手机软键盘弹出来。关掉时还回原来那个元素。 */
  useEffect(() => {
    if (!open) return;
    if (!panel.current?.contains(document.activeElement)) {
      prevFocus.current = document.activeElement as HTMLElement | null;
    }
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    // 手机软键盘弹出时把整块顶上去：--kb 是 hooks.ts 量的键盘高度。
    // 里面那层 max-h 用 min(86dvh, 100%) —— 没键盘时还是原来的 86dvh，
    // 有键盘时 100% 就是「键盘上沿以上」那点空间，不会把按钮顶出屏幕。
    <div className="fixed inset-0 z-[70] flex items-end justify-center pb-[var(--kb,0px)] sm:items-center">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? tid : undefined}
        aria-label={title === undefined ? '提示' : undefined}
        tabIndex={-1}
        className={cx(
          'relative z-10 w-full max-w-md bg-[var(--panel)] text-[var(--text)]',
          'rounded-t-[var(--r-xl)] sm:rounded-[var(--r-xl)] shadow-xl max-h-[min(86dvh,100%)] flex flex-col',
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <div className="text-[15px] font-semibold" id={tid}>{title}</div>
            <Btn variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </Btn>
          </div>
        )}
        <div className="overflow-y-auto px-5 py-2 text-sm leading-relaxed">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ================================ 确认 ================================ */

export interface ConfirmOptions {
  title: string;
  /** 正文要写清连带后果 —— 只说「确定删除吗」等于没说 */
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmOptions | null>(null);
  const resolve = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    // 前一个还没回答就再弹一个的话，先把前一个按「取消」结掉 ——
    // 否则它的 Promise 永远悬着，调用方的 await 就再也不往下走了
    if (resolve.current) resolve.current(false);
    return new Promise<boolean>((res) => {
      resolve.current = res;
      setReq(o);
    });
  }, []);

  const done = useCallback((v: boolean) => {
    const r = resolve.current;
    resolve.current = null;
    setReq(null);
    r?.(v);
  }, []);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Sheet
        open={!!req}
        onClose={() => done(false)}
        title={req?.title}
        dismissable
        footer={
          <>
            <Btn variant="ghost" onClick={() => done(false)}>
              {req?.cancelText || '取消'}
            </Btn>
            <Btn variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
              {req?.confirmText || '确定'}
            </Btn>
          </>
        }
      >
        {req?.body}
      </Sheet>
    </ConfirmCtx.Provider>
  );
}

/** 拿一个返回 Promise<boolean> 的 confirm。组件树里必须有 ConfirmProvider */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmCtx);
  if (!fn) throw new Error('useConfirm 必须放在 ConfirmProvider 里面');
  return fn;
}

/* ================================ 提示 ================================ */

export interface Toast {
  id: number;
  text: string;
  /** 带撤销的提示留久一点，用户得来得及点 */
  action?: { label: string; run: () => void };
}

type ToastListener = (t: Omit<Toast, 'id'>) => void;

let toastListener: ToastListener | null = null;

/** 全局提示。命令式调用，不占组件树 —— 任何地方（含非组件代码）都能用 */
export function toast(text: string, action?: Toast['action']): void {
  toastListener?.({ text, action });
}

export function ToastHost() {
  const [list, setList] = useState<Toast[]>([]);

  useEffect(() => {
    let id = 0;
    toastListener = (t) => {
      const item: Toast = { ...t, id: ++id };
      setList((prev) => [...prev, item]);
      // 带操作的留 6 秒，纯通知 2.6 秒
      const life = t.action ? 6000 : 2600;
      setTimeout(() => setList((prev) => prev.filter((x) => x.id !== item.id)), life);
    };
    return () => { toastListener = null; };
  }, []);

  if (!list.length) return null;

  return createPortal(
    <div className="fixed left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2"
         style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 76px)' }}>
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className="flex items-center gap-3 rounded-[var(--r-md)] bg-[rgba(24,26,32,.94)] px-4 py-2.5
                     text-sm text-white shadow-lg backdrop-blur"
        >
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              /* 写死不跟 --primary：toast 的底是 rgba(24,26,32,.94)，两套主题都深，
                 所以动作文字必须**恒浅**。跟 --primary 的话亮色那个 #395ef6 压上去只有 3.69。 */
              className="rounded-[var(--r-sm)] px-2 py-0.5 font-medium text-[#8fb0ff] hover:bg-white/10"
              onClick={() => { t.action!.run(); setList((p) => p.filter((x) => x.id !== t.id)); }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ================================ 图标按钮 ================================ */

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn(
  { label, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-[var(--r-pill)] transition',
        'text-[var(--text-2)] hover:bg-[var(--panel-3)]',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
});

/** 给外部（比如在 effect 里）用的遮罩层元素引用类型别名 */
export type ElRef = RefObject<HTMLElement | null>;

/* ============================ 自定义下拉选择器 ============================ */

export interface DropdownOption<K extends string | number> {
  value: K;
  label: string;
  disabled?: boolean;
}

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
  renderValue?: (option: DropdownOption<K>) => ReactNode;
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
          'inline-flex min-w-0 items-center justify-between gap-2 rounded-[var(--r-md)] border-[var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] text-[var(--text)] outline-none transition',
          'hover:border-[var(--primary)] focus:border-[var(--primary)] focus:bg-[var(--panel)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          SIZE[size],
          className,
        )}
      >
        <span className="min-w-0 truncate text-left">
          {current ? (renderValue ? renderValue(current) : current.label) : placeholder}
        </span>
        <ChevronDown size={14} aria-hidden="true" className={cx('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className={cx(
            'absolute left-0 top-[calc(100%+4px)] z-[60] max-h-64 min-w-full overflow-y-auto rounded-[var(--r-md)] border-[var(--border-w)] border-[var(--input)] bg-[var(--panel)] p-1 shadow-lg',
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
                <span className="min-w-0 flex-1">{renderOption ? renderOption(option, selected) : option.label}</span>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================ 胶囊选择器 ============================ */

/**
 * 一排二选一 / 多选一的胶囊。
 *
 * **不是 `<select>`**：原生 select 在 PWA 里样式不可控、和项目设计系统不一致，
 * 且移动端体验差。小选项集（≤ 7 个固定选项）一律用这个。
 *
 * 全局原则见 CLAUDE.md「三、界面约定」末尾。
 */
export function Chips<K extends string | number>({ value, options, onPick, render, labelOf, label, labelledBy }: {
  value: K;
  options: readonly K[];
  onPick: (k: K) => void;
  /** 色板那一轴要在胶囊里画一个色点 */
  render?: (k: K) => ReactNode;
  /** 把选项 key 显示成什么文字。不传就用 key 本身 */
  labelOf?: (k: K) => string;
  /** 这组控件的无障碍名字（没有可见标签时用） */
  label?: string;
  /** 有可见标签时，指向那个标签元素的 id —— 比 label 更准，且不用把文字写两遍 */
  labelledBy?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map((k) => {
        const on = k === value;
        return (
          <button
            key={String(k)}
            type="button"
            data-pick={k}
            aria-pressed={on}
            onClick={() => onPick(k)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 py-1 text-[12.5px] transition',
              on
                ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                : 'text-[var(--text-2)] hover:bg-[var(--panel-3)] border-[var(--border)]',
            )}
          >
            {render?.(k)}
            {labelOf ? labelOf(k) : k}
          </button>
        );
      })}
    </div>
  );
}

/* ============================ Sheet 选择器 ============================ */

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
