/**
 * sse.ts —— SSE 解析
 */

import type { AiEvent } from './events.ts';

/**
 * 从缓冲区里切出**已经完整**的事件，返回剩下没切完的那截。
 *
 * 调用方负责把剩下的那截留到下一个 chunk 前面 —— 这是这个函数唯一的契约，
 * 也是最容易漏的一步：不留 rest 就是「每个 chunk 边界上丢一个事件」。
 *
 * 规则按 SSE 规范来，但只实现用得到的部分：
 *   - 一条消息以**空行**结束（这里只认 `\n\n`；服务器不会发 `\r\n`）
 *   - `data:` 行可以有任意多行，拼接时中间补 `\n`
 *   - `:` 开头是注释行，忽略
 *   - 别的字段（`event:` / `id:` / `retry:`）不用，忽略掉
 *
 * **坏行只丢那一条，不抛。** 服务端多打一行日志、或者 JSON 里有个
 * 半截的中文，都不该让整轮对话当场断掉 —— 那比少一句话难查得多。
 */
export function sseFeed(buf: string): { events: AiEvent[]; rest: string } {
  const events: AiEvent[] = [];
  let rest = buf;

  for (;;) {
    const at = rest.indexOf('\n\n');
    if (at < 0) break;
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);

    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      // 规范说冒号后面那**一个**空格要去掉，多余的空格属于数据本身
      data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;

    try {
      const ev = JSON.parse(data.join('\n')) as AiEvent;
      if (ev && typeof ev.type === 'string') events.push(ev);
    } catch (_) { /* 坏事件跳过，别把整条流带走 */ }
  }

  return { events, rest };
}
