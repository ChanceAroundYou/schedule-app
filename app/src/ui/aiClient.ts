/**
 * aiClient.ts —— 读 SSE 的那一段（fetch + ReadableStream）
 *
 * **为什么不能用 `EventSource`**：它只能 GET、不能带 `Authorization` 头。
 * 而 `/api/ai/chat` 两样都需要（要 POST 一段用户输入、要鉴权），所以只能
 * 手写读流。
 *
 * 切行那部分在 `domain/ai.ts` 的 `sseFeed()` 里 —— 那是纯函数、有单测。
 * 这个文件只管「把字节读出来喂给它」，网络和解析分开。
 */

import { getToken } from '../data/api.ts';
import { sseFeed } from '../domain/ai.ts';
import type { AiEvent } from '../domain/ai.ts';

/** 与 `data/api/request.ts` 同一套基址规则，默认 `.` 保持网页版行为不变 */
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) || '.';

export interface ChatRequest {
  text: string;
  sessionId?: string | null;
  context?: Record<string, unknown>;
}

/**
 * 发一轮对话。每个事件回调一次 `onEvent`，函数在流结束时 resolve。
 *
 * **服务器开了流就先回了 200**，所以模型出错（连不上、401、没填 key）不会
 * 走这个函数的 catch —— 它是流里的一条 `{type:'error'}` 事件。调用方两种都要
 * 处理：这里抛的是「连不上本应用的后端」，事件里那条才是「连不上模型服务」。
 */
export async function chatStream(
  reqBody: ChatRequest,
  onEvent: (ev: AiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  let res: Response;
  try {
    res = await fetch(API_BASE + '/api/ai/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new Error('连不上服务器');
  }

  // 限速 429、没登录 401、参数不对 400 —— 这几条是**开流之前**返回的普通 JSON
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = `请求失败（${res.status}）`;
    try {
      const b = JSON.parse(raw) as { error?: string };
      if (b && b.error) msg = b.error;
    } catch (_) { /* 不是 JSON 就用上面那句兜底 */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('这个浏览器不支持流式读取');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true —— 一个中文字可能被切成两半，不这么写会解出乱码
      buf += decoder.decode(value, { stream: true });

      const out = sseFeed(buf);
      buf = out.rest;
      for (const ev of out.events) onEvent(ev);
    }
  } finally {
    // 用户中途取消（或组件卸载）时，把连接放掉。不放的话浏览器会一直
    // 占着那条流，服务端那边的 abort 也就不会触发
    reader.cancel().catch(() => {});
  }

  // 最后一块可能没有以空行结尾，补一次 —— 丢了的话最后一个事件（一般是 done）就没了
  buf += decoder.decode();
  const tail = sseFeed(buf.endsWith('\n\n') ? buf : buf + '\n\n');
  for (const ev of tail.events) onEvent(ev);
}
