/**
 * Confirm —— 确认弹层
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet.tsx';
import { Btn } from './Btn.tsx';

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
