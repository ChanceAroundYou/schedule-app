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
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type ButtonHTMLAttributes, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from './cx.ts';
import { useOutsideClose } from './hooks.ts';

/* ================================ 按钮 ================================ */

type Variant = 'primary' | 'ghost' | 'danger' | 'chip';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-[var(--accent,#4f7cff)] text-white hover:brightness-95 active:brightness-90',
  ghost: 'bg-transparent text-[var(--text-2,#5b6070)] hover:bg-[var(--hover,rgba(0,0,0,.05))]',
  danger: 'bg-[var(--danger,#e5484d)] text-white hover:brightness-95',
  chip: 'bg-[var(--chip,rgba(0,0,0,.05))] text-[var(--text,#1c1f26)] hover:brightness-95',
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
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition',
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
  useOutsideClose(panel, open && dismissable, onClose);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className={cx(
          'relative z-10 w-full max-w-md bg-[var(--card,#fff)] text-[var(--text,#1c1f26)]',
          'rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[86dvh] flex flex-col',
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <div className="text-[15px] font-semibold">{title}</div>
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
              className="rounded-md px-2 py-0.5 font-medium text-[var(--accent,#8fb0ff)] hover:bg-white/10"
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
        'inline-flex h-8 w-8 items-center justify-center rounded-full transition',
        'text-[var(--text-2,#5b6070)] hover:bg-[var(--hover,rgba(0,0,0,.05))]',
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
