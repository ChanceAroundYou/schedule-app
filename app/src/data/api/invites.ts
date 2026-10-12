/**
 * invites.ts —— 邀请相关 API
 */

import type { Invite, Role } from '../../domain/types.ts';
import { req } from './request.ts';

export const invites = {
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
