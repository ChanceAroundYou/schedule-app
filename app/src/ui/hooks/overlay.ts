/**
 * overlay.ts —— 浮层交互 hooks（焦点圈 / 外部关闭）
 */

import { useEffect, useRef } from 'react';

/**
 * mousedown + capture 收起浮层。不用 capture 的话，面板内 input 的 blur 会抢先关掉它。
 *
 * `trigger` 是**开合那个按钮**。没有它就会跟开关自己打架：mousedown 先关，
 * 紧接着 click 又把状态翻回来 —— 表现是「点搜索键关不掉搜索框」，
 * 而且只在真机上出现（合成 click 不派发 mousedown，所以 `clickEl` 那套
 * 测试永远测不出来）。判据是「这一下是不是落在开关上」，不是「浮层开没开」。
 */
export function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  trigger?: React.RefObject<HTMLElement | null>,
): void {
  const cb = useRef(close);
  cb.current = close;
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target as Element | null;
      if (el && el.contains(t as Node)) return;
      if (trigger?.current?.contains(t as Node)) return;
      /* 嵌套浮层：「浮层里再弹一层」（SheetPicker、更多→日程集多选）。
         里面那层是 portal 到 body 的 —— DOM 上不是本面板的后代，于是 `contains`
         判不出来，这一下会被当成「点到外面」。capture 阶段的 mousedown 会**先一步**
         把本层关掉、连带把里层一起卸载，用户这一次点击就丢了：症状是「点选项没反应，
         浮层倒是没了」。而且只在真机上出现 —— 合成 click 不派发 mousedown，
         `clickEl` 那套测试永远测不出来（同上面 trigger 那条）。
         判据不是「在本面板外」，是「在**别的**浮层里」：拿落点自己那一棵
         `[data-sheet-root]` 跟本面板的比。落在本面板自己的遮罩上照旧要关。 */
      const own = (el?.closest('[data-sheet-root]') as Element | null) || null;
      const hit = (t?.closest?.('[data-sheet-root]') as Element | null) || null;
      if (hit && hit !== own) return;
      cb.current();
    };
    document.addEventListener('mousedown', on, true);
    return () => document.removeEventListener('mousedown', on, true);
  }, [ref, open, trigger]);
}

/**
 * Esc 关闭浮层，并**截断**这次按键 —— 不截的话 App 那层的 Esc 委托会跟着
 * 再关一次抽屉：抽屉的 Esc 和 App 的 Esc 都听见了，用户按一下关两层。
 *
 * 为什么单独抽出来：DatePicker / TimePicker 两份逐字相同，而「截断」这个
 * 细节恰恰是最容易在抄第二遍时忘掉的那半行。
 *
 * 用 capture 阶段 —— 要比 App 的 Esc 委托先听见。
 */
export function useEscape(open: boolean, close: () => void): void {
  const cb = useRef(close);
  cb.current = close;
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      cb.current();
    };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, [open]);
}

/**
 * 把 Tab 圈在一个浮层里。
 *
 * **为什么必须有**：`aria-modal="true"` 是对读屏的一句承诺 —— 「外面那些是
 * 惰性的，别念」。没有这道圈，Tab 一路走到背后的列表上，读屏就把外面念出来了，
 * 那句承诺当场变成假话。所以凡是标了 aria-modal 的浮层都要挂这个。
 *
 * **它不抢焦点**：开浮层时焦点放哪由调用方决定（见 Drawer / Sheet 里那句
 * `panel.focus()`）。这一条是隐私性做不到的 —— 只圈住 Tab，不替谁聚焦。
 *
 * 过滤掉看不见的控件：导入备份那个 `<input type=file>` 常年藏起来，
 * 把它算进首尾会让 Tab 卡在一个没有焦点环的元素上。
 */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.getClientRects().length);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      const inside = cur instanceof HTMLElement && root.contains(cur);
      // 焦点本来就在圈外（比如刚打开、还没送进去）：Tab 往回拉，别让它顺着走
      if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || cur === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [ref, active]);
}
