/**
 * modalFocus.ts —— 模态浮层的焦点进出。
 *
 * 同一段 effect 原本逐字抄在 Sheet / MoreSheet（Tabbar）/ useDrawer 三处。
 * 抄第二遍时最容易丢的是「记录前先 contains」那半行 —— 丢了不报错，只是
 * 从一条任务切到另一条时「还回哪」被擦掉，键盘用户得从页首重 Tab 一遍。
 *
 * **这个 hook 只管焦点，不管 Esc** —— 三个浮层的 Esc 故意不同，别合：
 *   - Drawer 自己挂（`useDrawer.ts`）；
 *   - MoreSheet **交给上层**（`Workbench.tsx` 按 more→search→jump→drawer 排顺序），
 *     自身**不**挂 —— 合进来就会破坏那个顺序；
 *   - Sheet 自己挂，带 `dismissable` 开关。
 */
import { useEffect, useRef, type RefObject } from 'react';

/**
 * @param open   关着时不做事
 * @param panel  浮层本体。焦点送进**面板本身**，不是第一个控件 ——
 *               送进输入框会当场弹手机软键盘（用户明确要求过：别抢焦点弹键盘）
 */
export function useModalFocus(panel: RefObject<HTMLElement | null>, open: boolean): void {
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    if (!panel.current?.contains(document.activeElement)) {
      prevFocus.current = document.activeElement as HTMLElement | null;
    }
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (!el || !el.isConnected) return;
      /* **延后到下一帧再还焦点。** cleanup 跑的时候浮层刚决定关、上级还没把
         「模态开着」的 body 类摘掉（那在另一个 effect 里，本轮 commit 的被动
         阶段才跑）—— 此刻原来那个元素可能还是 `display: none`（例如快速添加条
         在抽屉开着时整条退场），对隐藏元素 focus() 是静默失败，焦点会掉到
         body 上，用户接着按 Tab 从页首开始（2026-10-19 实测踩到）。 */
      requestAnimationFrame(() => {
        if (el.isConnected) el.focus({ preventScroll: true });
      });
    };
  }, [panel, open]);
}
