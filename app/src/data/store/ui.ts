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
/* ------------------------------------------------- 多选（批量管理，2026-10-14） */

/**
 * 进入多选。`[]` = 已进入但一条没选（与 null = 没在多选，是两回事）。
 * 列表工具栏、行的高亮、点击行为都以它为准。
 */
export function selStart(): void {
  setUi({ sel: [] });
}

/** 退出多选 */
export function selCancel(): void {
  setUi({ sel: null });
}

/** 勾选 / 取消勾选一条 */
export function selToggle(id: string): void {
  const cur = state.ui.sel;
  if (cur === null) return;
  const i = cur.indexOf(id);
  setUi({ sel: i >= 0 ? cur.filter((x) => x !== id) : [...cur, id] });
}

/** 全选 / 全不选（工具栏那个「全选」按钮） */
export function selAll(ids: string[]): void {
  const cur = state.ui.sel;
  if (cur === null) return;
  setUi({ sel: cur.length >= ids.length ? [] : ids.slice() });
}
