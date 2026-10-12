/**
 * auth.ts —— 认证相关 API
 */

import type { PublicUser } from '../../domain/types.ts';
import { req } from './request.ts';
import { setToken, setCachedUser, type AuthResult } from './token.ts';

export const auth = {
  health: () => req<{ ok: boolean; time: number }>('GET', 'health'),

  /** 自助注册，开放。注册成功服务器会顺手建一个「我的日程」 */
  register: (name: string, password: string) =>
    req<AuthResult>('POST', 'auth/register', { name, password }),

  login: (name: string, password: string) =>
    req<AuthResult>('POST', 'auth/login', { name, password }),

  logout: () => req<{ ok: boolean }>('POST', 'auth/logout', {}),

  /**
   * 改口令。
   *
   * 服务器会**作废掉改动之前签发的所有 token**（包括请求里用的那一只），
   * 并在响应里带回一只新的 —— 所以这里必须立刻换上，否则下一次请求就 401。
   * 用户感知不到这个替换：不重新登录、不打断正在进行的操作。
   */
  changePassword: async (oldPassword: string, newPassword: string) => {
    const r = await req<AuthResult>(
      'POST', 'auth/password', { oldPassword, newPassword },
      { keepTokenOn401: true },
    );
    setToken(r.token);
    setCachedUser(r.user);
    return r;
  },

  /** 启动只发这一个请求：我是谁、我有哪些集、谁邀请了我 */
  me: () => req<{ user: PublicUser; cals: import('../../domain/types.ts').Cal[]; invites: import('../../domain/types.ts').Invite[] }>('GET', 'me'),
};
