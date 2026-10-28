/**
 * persist.ts —— localStorage 落盘与读回
 */
import type { LocalState } from '../../domain/types.ts';
import { hydrateHabit, hydrateTask, hydrateProject, normalizeUi } from '../../domain/model.ts';
import { getCachedUser } from '../api/token.ts';
import { state, setState, blank, KEY, resolveCal, emit } from './core.ts';

/**
 * 写 localStorage 是同步的，而且要把整个 state 序列化一遍（可能几百 KB）。
 * 搜索框每敲一个字都写一次会明显卡手，所以攒 250ms 再写。
 * pagehide / 切后台时立刻落盘，别把最后几个字丢在定时器里。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, 250);
}

export function flushPersist(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* 配额满，忽略 */ }
}

export function load(): LocalState {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch (_) { /* 隐私模式 */ }
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<LocalState>;
      setState({
        tasks: p.tasks || {},
        habits: p.habits || {},
        projects: p.projects || {},
        cals: Array.isArray(p.cals) ? p.cals : [],
        invites: Array.isArray(p.invites) ? p.invites : [],
        users: p.users && typeof p.users === 'object' ? p.users : {},
        /* 「我是谁」优先信本地缓存的那份（离线启动也要能认出「这条是我建的」），
           缓存没有就用落盘的那份兜一下 */
        meId: getCachedUser()?.id ?? (typeof p.meId === 'string' ? p.meId : null),
        cursor: Number(p.cursor) || 0,
        outbox: Array.isArray(p.outbox) ? p.outbox : [],
        ui: normalizeUi(p.ui),
        lastError: p.lastError ?? null,
        clockBlocked: Array.isArray(p.clockBlocked) ? p.clockBlocked : [],
        syncing: false,   // 瞬时状态，别把上次关页面时的 true 带进来
        denied: 0,
        deniedCals: [],   // 同上：这是「这次点击」的上下文，跨页面加载没有意义
        // 冲突提示**要留**：它说的是「你那一下被盖掉了」，刷新一次就忘掉
        // 等于没提示过 —— 用户正是在刷新之后才去看那条任务
        conflicts: Array.isArray(p.conflicts) ? p.conflicts : [],
      });
      // 磁盘上那份可能是旧版本写的、或者上一轮同步只写了一半的稀疏实体
      for (const t of Object.values(state.tasks)) hydrateTask(t);
      for (const h of Object.values(state.habits)) hydrateHabit(h);
      for (const j of Object.values(state.projects)) hydrateProject(j);
      resolveCal();
    } catch (_) {
      setState(blank());   // 坏数据就当没存过，别让整个应用打不开
    }
  }
  emit();
  return state;
}

export function resetLocal(): void {
  setState(blank());
  try { localStorage.removeItem(KEY); } catch (_) { /* 忽略 */ }
  emit();
}