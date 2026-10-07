/**
 * ai/sse.mjs —— 流式响应
 *
 * 这是**第二条响应通路**。server.js 的 `send()` 只会写一个 JSON 对象
 * （算好 Content-Length 再 end），而 SSE 要的是「先发头、然后一直往里写、
 * 最后才 end」。所以处理器多了一种返回形状 `{ raw: true }`，表示「响应我自己写」。
 *
 * 事件格式只有一种：
 *
 *     data: {"type":"text","delta":"下"}\n\n
 *
 * 类型放在 JSON 里而不是 SSE 的 `event:` 行 —— 客户端因此只需要一个
 * `JSON.parse`，不用同时维护 EventSource 式的事件名分派。反正两边都得读 JSON。
 *
 * 每一行都以 `\n\n` 结尾（SSE 的一条消息以空行结束），别写成 `\r\n`：
 * 规范两种都收，但混着用的时候拦截器会出乱子。
 */

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // 别让任何一层缓存住它 —— 一个被缓存的对话流是没法 debug 的
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  // nginx 专用的提示：告诉它这一条别开缓冲（虽然 deploy/schedule.conf 里
  // 也写了 proxy_buffering off，两层都写是因为这个头在别的反代上同样有效）
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};

/** 开始一个流。之后这个响应归调用方管，别再走 send()。 */
export function openStream(res) {
  res.writeHead(200, HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

/**
 * 写一条事件。客户端断开后 write 会抛 EPIPE —— 那属于正常收场
 * （用户关了页面），不该变成一条 500 日志。
 */
export function sendEvent(res, event) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

export function endStream(res) {
  if (!res.writableEnded && !res.destroyed) {
    try { res.end(); } catch (_) { /* 已经断了 */ }
  }
}

/**
 * 「用户关掉了页面」的信号。用 `close` 而不是 `aborted`：
 * aborted 只在请求体阶段有意义，响应阶段的断开只发 close。
 */
export function abortOnClose(res, onAbort) {
  res.on('close', () => {
    if (!res.writableEnded) onAbort();
  });
}
