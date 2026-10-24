/**
 * lift.ts —— 拖拽时把卡片「分身」画到 body 上，本体原地隐身
 *
 * **为什么需要**：拖拽不用浮层替身，被拖的就是卡片自己（dnd-kit 给 transform）。
 * 但未定时区（.allday-zone / .wun-cell）和月视图格子（.cell-tasks）为了能滚
 * 设了 overflow-y:auto —— 卡片被拖出这个框就被容器**裁掉**，症状是
 * 「一拖就整个消失」（用户 2026-10-23 报）。
 *
 * **为什么不用 position:fixed 挪本体**：本体一离开文档流，dnd-kit 会重测量
 * 并给 transform 加上布局位移的补偿（实测恒定 +24 = 一行的行距），卡片从此
 * 比鼠标偏一大截（同日报「点击位置和实际位置差一大截，灵敏度大大下降」）。
 * **本体原地不动**（visibility 隐身、占位不变）就完全不触发那套补偿 ——
 * dnd 的位移是纯指针位移。
 *
 * **做法**：pointerdown 那一刻先量好卡片「未位移」的原始位置（此刻还没有
 * 任何 transform）；拖起后用 createPortal 把一个**分身**画到 body 上
 * （fixed 定位 + dnd 位移 + pointer-events:none），本体 visibility 隐身。
 * 分身不受任何祖先裁剪。松手全部恢复。
 *
 * ⚠️ 只在**会被裁的卡片**上启用（未定时卡 / 月视图胶囊），定时卡保持原样。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface GhostRect { left: number; top: number; width: number; height: number; }

export function useDragGhost(active: boolean) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const rectRef = useRef<GhostRect | null>(null);
  const [ghostRect, setGhostRect] = useState<GhostRect | null>(null);

  const setNodeRef = useCallback((el: HTMLElement | null) => { nodeRef.current = el; }, []);

  /* pointerdown 那一刻先量：此刻卡片还没有任何 transform / translate */
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    const onDown = () => {
      const r = el.getBoundingClientRect();
      rectRef.current = { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    el.addEventListener('pointerdown', onDown, true);
    return () => el.removeEventListener('pointerdown', onDown, true);
  }, []);

  useEffect(() => {
    if (!active) { setGhostRect(null); return; }
    setGhostRect(rectRef.current);
  }, [active]);

  return { setNodeRef, ghostRect };
}
