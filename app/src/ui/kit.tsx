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
import { Check, ChevronDown, Pencil, X } from 'lucide-react';
import { cx } from './cx.ts';
import { useFocusTrap, useOutsideClose } from './hooks.ts';

/* ================================ 按钮 ================================ */

/* 六种固定 variant，覆盖全应用所有按钮场景：
   primary  主操作（保存、确认、跳转）
    normal  普通操作（导航、切换、取消）
    ghost   极轻操作（关闭、清空）
    danger  危险操作（删除、退出）
    chip    标签式操作（筛选、选择）—— 未选中的那一档
    chipOn  **同一个胶囊的选中档**
   `chip` / `chipOn` 是一对，`Chips` 在这两档之间切。两者**边框都在**，
   选中只换颜色不换几何 —— 少一圈边框会让选中的那个缩 2px，一排胶囊
   点一下整体抖一下。
   **选中档不填充底色，只把描边和文字换成主色。** 原来填的是
   `bg-[var(--primary)]`，于是色板那一行的色点（它画的就是 `--primary`）
   整个消失在主色底上 —— 用户的原话是「颜色圆点完全看不见」。
   不填充之后色点在 `--panel` 上正常显色，选中态靠主色描边 + 主色文字，
   和 `normal` 是同一个形状（有描边、有底色面），只是换成主色。
   分成两档而不是给 chip 叠一层 className：Tailwind 里同特异度的工具类
   谁赢只看生成顺序，叠 className 会在某个值上静默失效，症状正是
   「切风格时这个按钮和别的不一致」。
   新增 variant 必须先在这里加，再在 语义样式模块 里加对应样式 —— 别在
   .tsx 里写死颜色，那等于把设计令牌绕过去。 */
type Variant = 'primary' | 'normal' | 'ghost' | 'danger' | 'chip' | 'chipOn';

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
  normal: 'border-[length:var(--border-w)] border-[var(--input)] bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)] hover:text-[var(--text)] hover:border-[var(--text-3)]',
  ghost: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)]',
  danger: 'border-[length:var(--border-w)] border-[var(--danger)] bg-transparent text-[var(--danger)] hover:bg-[var(--danger-soft)]',
  chip: 'border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel)] text-[var(--text-2)] hover:border-[var(--primary)] hover:text-[var(--primary)]',
  chipOn: 'border-[length:var(--border-w)] border-[var(--primary)] bg-[var(--panel)] font-medium text-[var(--primary)]',
};

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, string> = {
  sm: 'h-[30px] px-2.5 text-[12.5px]',
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
        'w-full rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none transition',
        dense && 'h-[30px] w-auto px-2 text-[12.5px]',
        'focus:border-[var(--primary)] focus:bg-[var(--panel)] focus:shadow-[0_0_0_3px_var(--primary-soft),var(--shadow-md)]',
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
          'w-full rounded-[var(--r-md)] border-[length:var(--border-w)] border-[var(--input)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none transition',
          'focus:border-[var(--primary)] focus:bg-[var(--panel)] focus:shadow-[0_0_0_3px_var(--primary-soft),var(--shadow-md)]',
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

/**
 * 行内紧凑图标按钮：24×24，用在**由 13px 文本撑高的行**里（成员行、邀请行）。
 *
 * 为什么不直接用 `IconBtn`：它是 32px，塞进成员行会把整行顶高 11px。
 * 为什么要有这个组件而不是各处手写：这个形状原先在 `Members.tsx`、
 * `Settings.tsx`、`Calendars.tsx` 里各写了一遍，圆角取的是 `--r-xs`
 * （风格轴最小那一档）而不是行内控件该用的 `--r-sm`，而且只有 hover 变红、
 * 没有按下态。收成一处，改一次三处都跟着走。
 *
 * 24px 是 WCAG 2.5.8 的下限 —— **别再往小改**（18px 的点按不准）。
 * `danger` 给「移出 / 撤回」这类会改变关系的操作。
 *
 * ⚠️ **尺寸必须写 `h-[24px] w-[24px]`，不能写 `h-6 w-6`。**
 * Tailwind 的间距刻度是「0.25rem × n」，而本项目 `html { font-size: 14px }`
 * （tokens.css），于是 `1rem = 14px`、一档 = **3.5px** —— `h-6` 是 **21px**，
 * 比 24 差 3px。
 * 这个差不是「小一点无所谓」：21 < 24 就是没达到下限，而且肉眼看不出来。
 * 同一条也适用于别处写 `h-6` 当 24px 用的地方（本文件 `IconBtn` 的 `h-8`
 * 是 28px，达标，所以没暴露这个问题）。
 */
export const MiniIconBtn = forwardRef<HTMLButtonElement, IconBtnProps & { danger?: boolean }>(
  function MiniIconBtn({ label, danger = false, children, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        {...rest}
        className={cx(
          'inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[var(--r-sm)] transition',
          'disabled:cursor-not-allowed disabled:opacity-40',
          danger
            ? 'text-[var(--text-3)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]'
            : 'text-[var(--text-3)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

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

/* ============================ 胶囊选择器 ============================ */

/**
 * 一排二选一 / 多选一的胶囊。
 *
 * **不是 `<select>`**：原生 select 在 PWA 里样式不可控、和项目设计系统不一致，
 * 且移动端体验差。小选项集（≤ 7 个固定选项）一律用这个。
 *
 * **每个胶囊就是一个 `Btn`**（`chip` / `chipOn` 两档），不是另画一套。
 * 原先这里自己写了一遍 `rounded-[var(--r-pill)] border …`，和 `Btn` 差在三处：
 * 圆角走的是 `--r-pill` 而按钮走 `--r-md`、边框写死 Tailwind 的 `border`（1px）
 * 而按钮走 `--border-w`、未选中用装饰线 `--border` 而按钮用 ≥3:1 的 `--input`。
 * 于是「切到 flat 时别的按钮线变 2px、这几个还是 1px」「切到 notion 时圆角
 * 和旁边按钮不是一个数」—— 用户看到的就是「颜色和风格这些按钮跟别的不一样」。
 * 组件库的意义就是**没有第二套**，所以这里只有 `Btn` 一种画法。
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
          <Btn
            key={String(k)}
            data-pick={k}
            aria-pressed={on}
            onClick={() => onPick(k)}
            variant={on ? 'chipOn' : 'chip'}
            size="sm"
          >
            {render?.(k)}
            {labelOf ? labelOf(k) : k}
          </Btn>
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

/* ============================== 布局原语 ============================== */

/*
 * `Card` / `Field` / `Row` —— 设置页那种「一张卡 = 一个主题，卡内一组小节，
 * 小节标题在上、内容在下」的排法。
 *
 * 为什么放在组件库而不是设置页里：这套排法 `Settings.tsx` 和 `Members.tsx`
 * 都要用（成员 / 邀请那两块在两个地方渲染），而 `Members.tsx` 原先是把标题
 * 那一行 `mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]`
 * **逐字抄了两遍**。抄出来的第二套一定会漂 —— 这正是这次要修的那类问题。
 *
 * 描边走 `--border-w` 而不是 Tailwind 的 `border`（写死 1px）：切到 flat 时
 * 全应用的线都变 2px，只有这里还是 1px，看着就像「这一块没跟上风格」。
 */

/** 一张卡 = 一个主题。卡内一律由 `Field` 组成 */
export function Card({ icon, title, children, hint, extra }: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  hint?: ReactNode;
  /** 标题右边那一小块（比如「邀请收件箱」入口）。它是全局的，不属于卡里任何一个 Field */
  extra?: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-[var(--r-lg)] border-[length:var(--border-w)] border-[var(--border)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        {/* 标题是 h2，`extra` 是它的**兄弟**而不是子节点 —— 里面可能是个按钮，
            交互内容套在标题里读屏会念成一团 */}
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold">
          <span className="shrink-0 text-[var(--text-3)]">{icon}</span>
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        {extra}
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
      {hint && <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </section>
  );
}

/**
 * 一个小节：**标题在上，内容在下**。设置页与成员区里每一组控件都走这个。
 *
 * `htmlFor` 传了才渲染成 `<label>`：小节标题大多是**一组控件的名字**
 * （色板 / 风格 / 深浅），那种该是 `div` —— 用 label 去套一组按钮，
 * 读屏会念成一个不存在的表单控件。真的是单个输入框时（日程集名字）才传
 * `htmlFor`，让它成为真正的 `<label>`。
 */
export function Field({ label, htmlFor, icon, children, hint }: {
  label: string;
  htmlFor?: string;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const head = 'mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]';
  return (
    <div>
      {htmlFor
        ? <label htmlFor={htmlFor} className={head}>{icon}{label}</label>
        : <div className={head}>{icon}{label}</div>}
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{hint}</div>}
    </div>
  );
}

/** 一行控件：flex 换行 + 统一间距。按钮排、输入框 + 按钮都走它 */
export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/* ============================== 行内改名 ============================== */

/**
 * 行内改名 —— 项目里**所有**改名都走它，形状固定一套：
 *
 *   平时    [ 显示内容 ][ 铅笔 ]
 *   编辑中  [ 输入框   ][ √ ][ ✕ ]
 *
 * **切换编辑态时左边那段内容一像素都不动**，这是这个组件存在的全部理由。
 * 做到它靠两条硬约束：
 *
 *   1. 动作槽**固定宽度**（`w-[52px]` = 24 + 4 + 24）。平时只放一个铅笔，
 *      但槽是右对齐的，所以铅笔落在将来 √ 该在的位置上 —— 看起来是「铅笔
 *      变成 √」，而不是「右边多出来两个按钮」。槽宽不变，左边可用宽度就
 *      不变，显示内容（常常是一段会截断的文字）就不会重新折行 / 换行。
 *   2. 行高交给**外层**：本组件自己不定高，由调用方给一个固定高度的容器
 *      （日程集 header 是 `h-[40px]`，输入框 `h-[28px]`、按钮 24px）。
 *      两态都落在同一个高度上，下面的东西才不会被顶一下。
 *
 * `display` 由调用方给 —— 它常常不是纯文字，而是「一段文字 + 徽标 + 箭头」
 * 这种本身可点的东西（日程集那一行点一下是展开）。给 ReactNode 而不是
 * `renderText` 就是为了这个：组件不去猜显示态长什么样，只负责把那三格
 * 摆稳。
 *
 * 编辑态里显示的是真 `<input>`，不是 `<span contenteditable>`：后者没有
 * 输入法、没有撤销栈、没有平台的读屏支持。
 */
export function InlineRename({ value, onSave, disabled, display, label, placeholder, inputProps, confirmProps }: {
  /** 已保存的值。存好了会跟着变（所以外部改名成功后显示内容也会更新） */
  value: string;
  /** 提交。**空串也照传** —— 校验与提示由调用方决定（不同场景的话不一样） */
  onSave: (next: string) => void;
  /** 没有权限改：铅笔按钮禁用，输入框也进不去 */
  disabled?: boolean;
  /** 平时那一格。默认就是 `value` 的纯文字 */
  display?: ReactNode;
  /** 输入框的可访问名字 */
  label: string;
  placeholder?: string;
  /** 透给输入框（探针抓手 `data-cal-name` 之类走这里） */
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
  /** 透给确认按钮（探针抓手 `data-cal-save` 走这里） */
  confirmProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  /* 存好了（或外面改了名）就同步草稿，免得下次点铅笔看到的是上一轮的字。
     `editing` 不在里面：正在改的时候外部刷新列表不该把用户打的字冲掉。 */
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const cancel = () => { setDraft(value); setEditing(false); };
  const commit = () => {
    setEditing(false);
    // 一模一样就别白跑一趟接口（服务端会把它当成一次真改名，触发同步）
    if (draft === value) return;
    onSave(draft);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {editing ? (
        <Input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 点铅笔就是要立刻改字
          autoFocus
          {...inputProps}
          value={draft}
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          className="h-[28px] min-w-0 flex-1"
        />
      ) : (
        /* 显示态的容器和编辑态的输入框**同一个 flex-1 槽**，所以宽度一致 ——
           调用方塞进来的按钮填满它就行，不用管自己是几格。 */
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {display ?? <span className="truncate">{value}</span>}
        </div>
      )}

      {/* 右对齐的固定宽槽：平时一个铅笔，编辑中 √+✕，右边那条边一动不动 */}
      <span className="flex w-[52px] shrink-0 items-center justify-end gap-1">
        {editing ? (
          <>
            <MiniIconBtn {...confirmProps} label="确认" onClick={commit}>
              <Check size={14} />
            </MiniIconBtn>
            <MiniIconBtn label="取消" onClick={cancel}>
              <X size={14} />
            </MiniIconBtn>
          </>
        ) : (
          <MiniIconBtn label="改名" disabled={disabled} onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </MiniIconBtn>
        )}
      </span>
    </div>
  );
}
