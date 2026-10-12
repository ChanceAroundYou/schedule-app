/**
 * api.ts —— 桶文件：保持 import 路径不变
 */

export { getToken, setToken, getCachedUser, setCachedUser } from './api/token.ts';
export type { AuthResult } from './api/token.ts';
export { ApiError } from './api/error.ts';
export { req } from './api/request.ts';
export type { SyncRequest } from './api/request.ts';
export { auth } from './api/auth.ts';
export { cals } from './api/cals.ts';
export { invites } from './api/invites.ts';
export { ai } from './api/ai.ts';

/** 组合的 api 对象（向后兼容） */
import { auth } from './api/auth.ts';
import { cals } from './api/cals.ts';
import { invites } from './api/invites.ts';
import { ai } from './api/ai.ts';
import { req } from './api/request.ts';
import type { SyncRequest } from './api/request.ts';
import type { SyncResponse } from '../domain/types.ts';

export const api = {
  ...auth,
  sync: (body: SyncRequest) => req<SyncResponse>('POST', 'sync', body),
  ...cals,
  ...invites,
  ...ai,
};
