/**
 * app/useContentEvents.ts —— 把那一个原生 click 监听挂到 `#content` 上
 *
 * 为什么是**原生**事件而不是 React 的 onClick：原先挂在 `display:contents` 的
 * div 上，但 React 18 的事件委托会跳过不生成盒子的元素（合成事件路径里没有它），
 * 那个 onClick **从来没触发过**。挂到 `#content`（普通元素，有盒子）上、
 * 用 addEventListener，行为一致，且不依赖 CSS 改一次就又坏一次。
 *
 * 分派靠 data-*（见 clickDispatch.ts）。**只有这一条监听** —— 长按操作层
 * 已于 2026-10-11 整体删除（用户明确要求），pointerdown / pointerup 那两条
 * 跟着一起没了。
 */
import { useEffect, type RefObject } from 'react';
import { makeOnClick, type ClickDeps } from './clickDispatch.ts';

export function useContentEvents(
  contentRef: RefObject<HTMLDivElement>,
  deps: ClickDeps,
) {
  const onClick = makeOnClick(deps);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const hClick = (e: MouseEvent) => { void onClick(e as unknown as React.MouseEvent); };

    el.addEventListener('click', hClick);
    return () => { el.removeEventListener('click', hClick); };
  }, [contentRef, onClick]);
}
