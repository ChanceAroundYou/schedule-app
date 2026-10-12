/**
 * shared.ts —— 日 / 周 / 月三视图共用的小工具
 */

export const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

export function hours24(): number[] {
  return Array.from({ length: 25 }, (_, h) => h);
}

export type LayoutEvent = { item: import('../../domain/types.ts').Task; start: number; end: number; col: number; cols: number };
