/**
 * app/useContentEvents.ts —— 把那几条原生监听挂到 `#content` 上
 *
 * 为什么是**原生**事件而不是 React 的 onClick：原先挂在 `display:contents` 的
 * div 上，但 React 18 的事件委托会跳过不生成盒子的元素（合成事件路径里没有它），
 * 那个 onClick **从来没触发过**。挂到 `#content`（普通元素，有盒子）上、
 * 用 addEventListener，行为一致，且不依赖 CSS 改一次就又坏一次。
 *
 * 分派靠 data-*（见 clickDispatch.ts）。**只有这一条监听** —— 长按操作层
 * 已于 2026-10-11 整体删除（用户明确要求），pointerdown / pointerup 那两条
 * 跟着一起没了。
 *
 * 两条监听而不是一条：`click` 管「按下去」，`change` 管「输入完失焦」
 * （当前唯一一处：项目泳道的「下一步」）。后者不是点击，挂在 data-act 上
 * 等 click 永远等不到 —— 那一条的完整理由在 clickDispatch.ts 的 onChange 上。
 */
import { useEffect, type RefObject } from 'react';
import { makeOnClick, makeOnChange, type ClickDeps } from './clickDispatch.ts';

export function useContentEvents(
  contentRef: RefObject<HTMLDivElement>,
  deps: ClickDeps,
) {
  const onClick = makeOnClick(deps);
  const onChange = makeOnChange();

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const hClick = (e: MouseEvent) => { void onClick(e as unknown as React.MouseEvent); };
    const hChange = (e: Event) => { onChange(e); };

    el.addEventListener('click', hClick);
    el.addEventListener('change', hChange);
    return () => {
      el.removeEventListener('click', hClick);
      el.removeEventListener('change', hChange);
    };
  }, [contentRef, onClick, onChange]);
}
