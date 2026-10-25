/**
 * hooks.ts —— React 与 store 的接缝（桶文件，保持 import 路径不变）
 */

export { useStoreState, useScopedState, useStoreSelector } from './hooks/store.ts';
export { useOnline, useKeyboardInset, useIsNarrow, isNarrowNow } from './hooks/viewport.ts';
export { useOutsideClose, useFocusTrap, useEscape } from './hooks/overlay.ts';
export { useAnchoredPosition, useAnchoredPositionFrom } from './hooks/anchored.ts';
export { useMeasuredHeight, useDebounced, useElementHeight, useElementWidth } from './hooks/utils.ts';
export { useModalFocus } from './hooks/modalFocus.ts';
