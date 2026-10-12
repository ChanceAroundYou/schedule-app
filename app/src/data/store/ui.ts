/**
 * ui.ts —— 界面偏好与瞬时同步状态
 *
 * **界面偏好不进同步**：手机换主题不该把桌面也换了。
 */
import type { UiPrefs } from '../../domain/types.ts';
import { state, emit } from './core.ts';
import { persist } from './persist.ts';

export function setUi(patch: Partial<UiPrefs>): void {
  state.ui = { ...state.ui, ...patch };
  persist();
  emit();
}

/* ------------------------------------------------------- 同步瞬时状态 */

export function setSyncing(v: boolean): void {
  if (state.syncing === v) return;
  state.syncing = v;
  emit();   // 不落盘：它只是「转圈圈图标要不要显示」
}

export function setError(msg: string | null): void {
  state.lastError = msg;
  persist();
  emit();
}

/** 软键盘 / 时钟漂移这类「拦下但没写」的实体 id —— 抽屉里会显示原因 */
export function setClockBlocked(ids: string[]): void {
  state.clockBlocked = ids;
  persist();
  emit();
}