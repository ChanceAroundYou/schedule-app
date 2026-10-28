/**
 * auth.ts —— 认证相关 API
 */

import type { PublicUser } from '../../domain/types.ts';
import { req } from './request.ts';
import { setToken, setCachedUser, type AuthResult } from './token.ts';
import { pushWidgetAuth } from '../widget.ts';

/** 登录成功后的统一收尾：换票 + 把票推给原生侧的小组件 */
function noteAuthed(r: AuthResult): void {
  setToken(r.token);
  setCachedUser(r.user);
  // 小组件要能不打开 App 就读写服务器，得有票。**void** —— 推失败只是
  // 小组件退回「只显示快照」，不影响用户正在做的事。
  void pushWidgetAuth(r.token);
}

export const auth = {
  health: () => req<{ ok: boolean; time: number }>('GET', 'health'),

  /** 自助注册，开放。注册成功服务器会顺手建一个「我的日程」。昵称可空 */
  register: async (name: string, password: string, nickname?: string | null) => {
    const nk = nickname?.trim() || null;
    const r = await req<AuthResult>('POST', 'auth/register', { name, password, ...(nk ? { nickname: nk } : {}) });
    noteAuthed(r);
    return r;
  },

  login: async (name: string, password: string) => {
    const r = await req<AuthResult>('POST', 'auth/login', { name, password });
    noteAuthed(r);
    return r;
  },

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
    noteAuthed(r);
    return r;
  },

  /** 启动只发这一个请求：我是谁、我有哪些集、谁邀请了我 */
  me: () => req<{ user: PublicUser; cals: import('../../domain/types.ts').Cal[]; invites: import('../../domain/types.ts').Invite[]; users?: Record<string, { name: string; nickname: string | null }> }>('GET', 'me'),

  /** 改昵称。传 null / 空串 = 取消昵称，回到用户名 */
  setNickname: (nickname: string | null) =>
    req<{ user: PublicUser }>('PATCH', 'me', { nickname }),
};
