/**
 * hooks.ts —— React 与 store 的接缝（桶文件，保持 import 路径不变）
 */

export { useStoreState, useScopedState, useStoreSelector } from './store.ts';
export { useOnline, useKeyboardInset, useIsNarrow } from './viewport.ts';
export { useOutsideClose, useFocusTrap } from './overlay.ts';
export { useMeasuredHeight, useDebounced } from './utils.ts';
