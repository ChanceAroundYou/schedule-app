/**
 * api.ts —— 后端 HTTP 客户端
 *
 * 路径一律用**相对地址**（`./api/...`），因为应用被部署在 /schedule/ 子路径下，
 * 写死 /api 会打到站点根。相对地址在两种环境下都对：
 *   线上  https://…/schedule/  →  /schedule/api/…   （nginx 反代到 25692）
 *   开发  http://127.0.0.1:5199/  →  /api/…          （vite proxy 转 25692）
 *
 * 这里不碰 store、不碰 localStorage 以外的东西 —— 它是一层薄封装，
 * 状态归 store.ts 管。
 */

import type {
  Cal, Invite, Member, Op, PublicUser, Role, SyncResponse,
} from '../domain/types.ts';

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

export class ApiError extends Error {
  status: number;
  /** 服务器给的可读原因，用来分辨「时钟不对」这类可重试的情况 */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** 网络层失败（没连上），或者 token 过期 —— 调用方据此决定是否提示重新登录 */
  get offline(): boolean { return this.status === 0; }
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch('./api/' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_) {
    throw new ApiError(0, '连不上服务器');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch (_) { throw new ApiError(res.status, '服务器返回了非 JSON 内容'); }
  }

  if (!res.ok) {
    // token 失效就地清掉，避免后面每个请求都白跑一趟 401
    if (res.status === 401) setToken(null);
    const b = data as { error?: string; code?: string } | null;
    throw new ApiError(res.status, (b && b.error) || ('请求失败（' + res.status + '）'), b?.code);
  }

  return data as T;
}

export interface SyncRequest {
  cursor: number;
  deviceId: string;
  ops: Op[];
}

export const api = {
  health: () => req<{ ok: boolean; time: number }>('GET', 'health'),

  /** 自助注册，开放。注册成功服务器会顺手建一个「我的日程」 */
  register: (name: string, password: string) =>
    req<AuthResult>('POST', 'auth/register', { name, password }),

  login: (name: string, password: string) =>
    req<AuthResult>('POST', 'auth/login', { name, password }),

  logout: () => req<{ ok: boolean }>('POST', 'auth/logout', {}),

  /** 启动只发这一个请求：我是谁、我有哪些集、谁邀请了我 */
  me: () => req<{ user: PublicUser; cals: Cal[]; invites: Invite[] }>('GET', 'me'),

  sync: (body: SyncRequest) => req<SyncResponse>('POST', 'sync', body),

  /* ------------------------------------------------------------ 日程集 */

  createCal: (name: string) =>
    req<{ cal: Cal }>('POST', 'cals', { name }).then((r) => r.cal),

  renameCal: (id: string, name: string) =>
    req<{ id: string; name: string }>('PATCH', `cals/${encodeURIComponent(id)}`, { name }),

  removeCal: (id: string) => req<{ ok: boolean }>('DELETE', `cals/${encodeURIComponent(id)}`),

  leaveCal: (id: string) => req<{ ok: boolean }>('POST', `cals/${encodeURIComponent(id)}/leave`, {}),

  members: (id: string) =>
    req<{ members: Member[]; invites: Invite[]; myRole: Role }>(
      'GET', `cals/${encodeURIComponent(id)}/members`, undefined,
    ),

  setRole: (id: string, userId: string, role: Role) =>
    req<{ ok: boolean }>(
      'PATCH', `cals/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role },
    ),

  kick: (id: string, userId: string) =>
    req<{ ok: boolean }>(
      'DELETE', `cals/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    ),

  /* -------------------------------------------------------------- 邀请 */

  /** 邀请要对方**接受**才生效 —— 这一步只是把邀请放进他的收件箱 */
  invite: (calId: string, name: string, role: Role) =>
    req<{ ok: boolean }>('POST', `cals/${encodeURIComponent(calId)}/invites`, { name, role }),

  sentInvites: (calId: string) =>
    req<{ invites: Invite[] }>('GET', `cals/${encodeURIComponent(calId)}/invites`).then((r) => r.invites),

  revokeInvite: (id: string) =>
    req<{ ok: boolean }>('DELETE', `invites/${encodeURIComponent(id)}`),

  myInvites: () => req<{ invites: Invite[] }>('GET', 'invites').then((r) => r.invites),

  acceptInvite: (id: string) =>
    req<{ ok: boolean; calId: string; role: Role }>(
      'POST', `invites/${encodeURIComponent(id)}/accept`, {},
    ),

  declineInvite: (id: string) =>
    req<{ ok: boolean }>('POST', `invites/${encodeURIComponent(id)}/decline`, {}),
};
