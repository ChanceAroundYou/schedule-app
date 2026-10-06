/**
 * contrast.mjs —— 锁住 legacy.css 的调色板对比度。零依赖，`node tests/contrast.mjs`。
 *
 * 为什么值得单独一个脚本：色板的取值是**算出来的**，但代码里只看得见十六进制，
 * 看不出「#687084 是 4.5:1 那条线」。谁觉得某个灰「太深了想调淡一点」，
 * 只要跑一次这里就会知道自己踩了什么 —— 这正是不久前真发生过的事
 * （--text-3 是 #949bab，2.79:1，38 处 11px 的有信息量文字读不清）。
 *
 * 断言的是 **--text / --text-2 / --text-3 对每一种底色**都要 ≥ 4.5:1。
 * 其余（胶囊、语义色）只**报告**不断言 —— 它们的现状是先天的，不是这次引入的，
 * 让脚本一上来就红着等于没人看它。见文件末尾那段说明。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../src/styles/legacy.css', import.meta.url));

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rel = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (fg, bg) => { const a = rel(fg), b = rel(bg); const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };

/** 抠出一个选择器块里的 --var: #hex */
function vars(src, sel) {
  const i = src.indexOf(sel);
  if (i < 0) throw new Error('找不到选择器 ' + sel + ' —— legacy.css 的结构变了？');
  const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('}', i));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

/** 文字可以落在上面的底色。--sidebar 与 --panel 同值也一起查，将来分开才测得出来 */
const SURFACES = ['--bg', '--panel', '--panel-2', '--panel-3', '--sidebar'];
/** 必须有 4.5:1：这三档承载信息（时间轴刻度、行内元信息、打卡连续天数…），不是装饰 */
const TIERS = ['--text', '--text-2', '--text-3'];

export function audit(src) {
  const rows = [];
  for (const [theme, p] of [['亮色', ':root'], ['暗色', '[data-theme="dark"]']]) {
    const v = vars(src, p);
    for (const t of TIERS) {
      for (const s of SURFACES) {
        if (v[t] && v[s]) rows.push({ theme, kind: 'tier', label: t + ' on ' + s, fg: v[t], bg: v[s], r: ratio(v[t], v[s]) });
      }
    }
    for (const k of Object.keys(v)) {          // 快速添加那组胶囊：fg/bg 成对预置的
      const m = /^--chip-(.+)fg$/.exec(k);
      const bgk = m && '--chip-' + m[1] + 'bg';
      if (bgk && v[bgk]) rows.push({ theme, kind: 'chip', label: k + ' on ' + bgk, fg: v[k], bg: v[bgk], r: ratio(v[k], v[bgk]) });
    }
    for (const k of ['--danger', '--primary', '--ok', '--warn']) {
      if (v[k]) rows.push({ theme, kind: 'accent', label: k + ' on --panel', fg: v[k], bg: v['--panel'], r: ratio(v[k], v['--panel']) });
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = audit(readFileSync(CSS, 'utf8'));
  const MARK = (r) => (r >= 4.5 ? '✓' : r >= 3 ? '✗ 只够大字' : '✗✗ 不足');
  let failed = 0;

  for (const theme of ['亮色', '暗色']) {
    console.log('\n' + theme + '　—— 正文三档（断言）');
    for (const r of rows.filter((x) => x.theme === theme && x.kind === 'tier')) {
      const ok = r.r >= 4.5;
      if (!ok) failed++;
      console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + r.label.padEnd(20) + r.fg + ' / ' + r.bg + '  ' + r.r.toFixed(2).padStart(6) + '  ' + MARK(r.r));
    }
    console.log(theme + '　—— 语义色 / 胶囊（只报告，不断言）');
    for (const r of rows.filter((x) => x.theme === theme && x.kind !== 'tier')) {
      console.log('  ' + (r.r >= 4.5 ? '    ' : '    ') + r.label.padEnd(28) + r.fg + ' / ' + r.bg + '  ' + r.r.toFixed(2).padStart(6) + '  ' + MARK(r.r));
    }
  }

  console.log('\n正文三档不达标 ' + failed + ' 条');
  console.log('（亮色的语义色与三个胶囊整体低于 4.5:1，暗色不低 —— 见 CLAUDE.md 五、配色）');
  process.exit(failed ? 1 : 0);
}
