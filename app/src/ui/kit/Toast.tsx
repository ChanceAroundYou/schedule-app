/**
 * Toast —— 全局提示
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
