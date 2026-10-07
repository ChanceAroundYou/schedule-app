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
 * 另一个约束：不用 emoji，全部走 lucide 图标。
 */

import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ReactNode, type ButtonHTMLAttributes, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from './cx.ts';
import { useFocusTrap, useOutsideClose } from './hooks.ts';

/* ================================ 按钮 ================================ */

type Variant = 'primary' | 'ghost' | 'danger' | 'chip';

/* 变量名一律写 legacy.css 里**真实存在**的那些，且**不给兜底值**。
   兜底值看着稳，其实是把「变量名写错了」变成静默降级：这里原先写的是
   --accent / --card / --line / --chip / --hover / --accent-soft 那一批，
   而 --accent / --accent-soft / --card / --chip / --hover / --line
   在 legacy.css 里**一个都没有** —— 于是两套主题下全是写死的颜色，
   主按钮那个 #4f7cff 压白字只有 3.70:1，暗色也没跟着 --primary 走。
   没有兜底值时写错名字会当场看得见（声明失效→继承），不会悄悄糊过去。
   tests/contrast.mjs 末尾有一条扫描锁着这件事。 */
const VARIANT: Record<Variant, string> = {
  primary: 'bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-95 active:brightness-90',
  ghost: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--panel-3)]',
  danger: 'bg-[var(--danger)] text-[var(--on-primary)] hover:brightness-95',
  chip: 'bg-[var(--panel-3)] text-[var(--text)] hover:brightness-95',
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

export function Btn({ variant = 'ghost', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--r-md)] font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANT[variant],
        className,
      )}
    />
  );
}

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
          'rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[min(86dvh,100%)] flex flex-col',
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
          className="flex items-center gap-3 rounded-xl bg-[rgba(24,26,32,.94)] px-4 py-2.5
                     text-sm text-white shadow-lg backdrop-blur"
        >
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              /* 写死不跟 --primary：toast 的底是 rgba(24,26,32,.94)，两套主题都深，
                 所以动作文字必须**恒浅**。跟 --primary 的话亮色那个 #395ef6 压上去只有 3.69。 */
              className="rounded-md px-2 py-0.5 font-medium text-[#8fb0ff] hover:bg-white/10"
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

export function IconBtn({ label, children, className, ...rest }: IconBtnProps) {
  return (
    <button
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
}

/** 给外部（比如在 effect 里）用的遮罩层元素引用类型别名 */
export type ElRef = RefObject<HTMLElement | null>;
