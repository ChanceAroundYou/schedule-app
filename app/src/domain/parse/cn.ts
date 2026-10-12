/**
 * cn.ts —— 中文数字转换
 */

const CN: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文数字 / 阿拉伯数字 → number。识别不了返回 null。 */
export function cn(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const str = String(s);
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const i = str.indexOf('十');
  if (i >= 0) {
    const a = str.slice(0, i);
    const b = str.slice(i + 1);
    const A = a === '' ? 1 : CN[a];
    if (A == null) return null;
    let n = A * 10;
    if (b !== '') {
      const B = CN[b];
      if (B == null) return null;
      n += B;
    }
    return n;
  }
  if (str.length === 1) return CN[str] == null ? null : CN[str];
  return null;
}
