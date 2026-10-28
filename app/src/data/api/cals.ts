/**
 * cals.ts —— 日程集相关 API
 */

import type { Cal, CalColorKey, Invite, Member, Role } from '../../domain/types.ts';
import { req } from './request.ts';

export const cals = {
  createCal: (name: string) =>
    req<{ cal: Cal }>('POST', 'cals', { name }).then((r) => r.cal),

  renameCal: (id: string, name: string) =>
    req<{ id: string; name: string }>('PATCH', `cals/${encodeURIComponent(id)}`, { name }),

  setColorCal: (id: string, color: CalColorKey) =>
    req<{ id: string; color: CalColorKey }>('PATCH', `cals/${encodeURIComponent(id)}`, { color }),

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
};
