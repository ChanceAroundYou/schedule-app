/**
 * token.ts —— token 与用户缓存
 */

import type { PublicUser } from '../../domain/types.ts';

const TOKEN_KEY = 'schedule-app-token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}

export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* 隐私模式，忽略 */ }
}

export interface AuthResult { token: string; user: PublicUser }

/**
 * 登录时把用户对象一并缓存下来：**离线启动**时界面要有名字可显示。
 *
 * 每次在线的同步拿到的是权威值（sync 响应里虽然不带 user，但 /api/me 会带），
 * 缓存只负责「服务器够不着时别显示空白」。
 */
const USER_KEY = 'schedule-app-user';

export function getCachedUser(): PublicUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch (_) { return null; }
}

export function setCachedUser(u: PublicUser | null): void {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch (_) { /* 隐私模式，忽略 */ }
}
