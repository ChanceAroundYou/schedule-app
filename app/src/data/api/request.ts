/**
 * request.ts —— HTTP 请求封装
 */

import type { Op } from '../../domain/types.ts';
import { getToken, setToken } from './token.ts';
import { ApiError } from './error.ts';

async function req<T>(
  method: string, path: string, body?: unknown,
  opts: { keepTokenOn401?: boolean } = {},
): Promise<T> {
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
    // token 失效就地清掉，避免后面每个请求都白跑一趟 401。
    //
    // **但「当前密码输错了」那条 401 是例外**：它说的是这一只请求里
    // 附带的 `oldPassword` 不对，**会话本身好好的**。照这里清掉 token 的话，
    // 用户手一抖打错一个字就会被自己踢出去，而他要做的只是重输一遍。
    // 用一个 opt 表达这个例外，而不是在调用点 try/catch —— 后者必然会漏。
    if (res.status === 401 && !opts.keepTokenOn401) setToken(null);
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

export { req };
