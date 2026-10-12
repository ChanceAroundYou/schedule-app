/**
 * context.ts —— 拖动态共享
 */

import { createContext, useContext } from 'react';

export interface DragState {
  activeId: string | null;
  activeKind: 'task' | 'habit' | 'nav' | null;
}

const DragCtx = createContext<DragState>({ activeId: null, activeKind: null });

/** 给 DragOverlay 和 sync 守卫读的当前拖动态 */
export function useDragSession(): DragState {
  return useContext(DragCtx);
}

export { DragCtx };
