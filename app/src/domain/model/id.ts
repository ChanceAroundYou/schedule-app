/**
 * id.ts —— 生成唯一 ID
 */

/**
 * UUIDv4。
 *
 * crypto.randomUUID 只在安全上下文可用 —— 用 http://192.168.x.x 打开时会
 * 直接 undefined。局域网自测很常见，所以留一条 getRandomValues 的退路。
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newOpId(): string {
  return newId();
}
