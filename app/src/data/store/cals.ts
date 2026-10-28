/**
 * cals.ts —— 日程集的本地集合与勾选
 *
 * **勾选（`ui.cals`）和归属（`ui.cal`）是两件事**：前者是「我想同时看哪几个」，
 * 后者是「新建的东西落哪儿」（必须是**一个**）。`toggleCal` 保证归属的集一定
 * 勾着 —— 否则新建的东西会落在看不见的集里，用户看到的是「凭空消失」。
 * 所以**至少永远有一个集是勾着的**，想只看某一个就取消勾掉别的。
 */
import type { Cal, Invite, LocalState } from '../../domain/types.ts';
import { state, getCals, getInvites, activeCal, differs, resolveCal, emit } from './core.ts';
import { persist } from './persist.ts';

/**
 * 丢掉属于「我已经不在里面」的集的本地数据。
 *
 * 被踢出 / 主动退出一个集之后，服务器不会再把这些集的东西发过来，本地那
 * 一份就永远留着了 —— 用户会看到自己明明已经退出的日程集还在列表里。
 *
 * 只在集列表非空时才清：服务器保证每人至少有一个集，收到空列表多半是
 * 请求出了问题，那时候清空等于把整台设备的数据抹掉。
 */
function pruneCals(): void {
  if (!state.cals.length) return;
  const ids = new Set(state.cals.map((c) => c.id));
  for (const [id, t] of Object.entries(state.tasks)) {
    if (t.calId && !ids.has(t.calId)) delete state.tasks[id];
  }
  for (const [id, h] of Object.entries(state.habits)) {
    if (h.calId && !ids.has(h.calId)) delete state.habits[id];
  }
  for (const [id, j] of Object.entries(state.projects)) {
    if (j.calId && !ids.has(j.calId)) delete state.projects[id];
  }
}

export function setCals(cals: Cal[] | undefined): void {
  if (!Array.isArray(cals) || !differs(state.cals, cals)) return;
  state.cals = cals;
  resolveCal();
  pruneCals();
  persist();
  emit();
}

/**
 * 目录有没有变。
 *
 * `differs` 只吃数组（它是给「列表」写的），而目录按 id 索引；这里自己判一次，
 * 而且**不依赖键的顺序** —— 服务器两次响应的键顺序不保证一致，用
 * `JSON.stringify` 比会把它当成变化、白 persist 一轮。
 */
function sameUsers(cur: LocalState['users'], next: LocalState['users']): boolean {
  const ck = Object.keys(cur), nk = Object.keys(next);
  if (ck.length !== nk.length) return false;
  for (const id of ck) {
    const a = cur[id], b = next[id];
    if (!b || a.name !== b.name || (a.nickname ?? null) !== (b.nickname ?? null)) return false;
  }
  return true;
}

export function setUsers(users: LocalState['users'] | undefined): void {
  if (!users || typeof users !== 'object' || sameUsers(state.users, users)) return;
  state.users = users;
  persist();
  emit();
}

export function setMeId(id: string | null | undefined): void {
  const next = typeof id === 'string' && id ? id : null;
  if (state.meId === next) return;
  state.meId = next;
  persist();
  emit();
}

export function setInvites(invites: Invite[] | undefined): void {
  if (!Array.isArray(invites) || !differs(state.invites, invites)) return;
  state.invites = invites;
  persist();
  emit();
}

/**
 * 切换当前看的集。纯本地偏好，不影响数据归属。
 *
 * 顺手让它**勾着**（侧栏是显示过滤，`ui.cal` 是它的归属 —— 归属的集没勾上，
 * 新建的东西就落在看不见的集里）。设成归属却不显示，等于凭空消失。
 */
export function setActiveCal(id: string): void {
  if (!state.cals.some((c) => c.id === id)) return;
  if (state.ui.cal === id && state.ui.cals.includes(id)) return;
  state.ui.cal = id;
  resolveCal();
  persist();
  emit();
}

/**
 * 勾 / 取消勾一个集（只管显示）。
 *
 * 顺带管一下**归属**（`ui.cal`，新东西落哪儿），因为归属和显示是分不开的：
 * 归属的集没勾上，新建的日程就落在日程页看不见的集里 —— 用户看到的是
 * 「凭空消失」。所以勾上它就让它当归属；取消勾掉它（也就是它本来是归属）
 * 就把归属交给**还在勾着的那个**，没有别的在勾就还给它。
 *
 * 所以实际上**至少永远有一个集是勾着的**：不勾任何东西让日程页全空看着像
 * 坏了，而且恢复得靠用户自己想起来。真想只看某一个集，取消勾掉别的就够了。
 */
export function toggleCal(id: string): void {
  if (!state.cals.some((c) => c.id === id)) return;
  const at = state.ui.cals.indexOf(id);
  if (at < 0) {
    state.ui.cals = [...state.ui.cals, id];
    state.ui.cal = id;
  } else {
    const left = state.ui.cals.filter((x) => x !== id);
    // 还有别的勾着就顺位给它，没有就**撤销这次取消** —— 归属不能没有显示的地方
    state.ui.cals = left.length ? left : state.ui.cals;
    if (left.length && state.ui.cal === id) state.ui.cal = left[0];
  }
  persist();
  emit();
}

/** 侧栏勾选显示的集。至少一个 —— 见 toggleCal 那段 */
export function shownCals(): string[] {
  return state.ui.cals;
}

export { getCals, getInvites, activeCal };