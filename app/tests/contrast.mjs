/**
 * contrast.mjs —— 锁住 legacy.css 的调色板对比度。零依赖，`node tests/contrast.mjs`。
 *
 * 为什么值得单独一个脚本：色板的取值是**算出来的**，但代码里只看得见十六进制，
 * 看不出「#687084 是 4.5:1 那条线」。谁觉得某个灰「太深了想调淡一点」，
 * 跑一次这里就会知道自己踩了什么 —— 这正是不久前真发生过的事：
 * --text-3 本来是 #949bab（2.79:1），亮色的语义色那一套更是整体 2.66–4.39，
 * 而它们承载的全是正文（时间轴刻度、错误提示、打卡连续天数、解析预览…）。
 *
 * 断言口径：**每一对「文字 on 它真正会落上去的底色」都要 ≥ 4.5:1**（WCAG 1.4.3 正文）。
 * 值全部从 CSS 里读，不是手抄的常量。
 *
 * 两条容易漏的：
 *   · --text-2 / --text-3 要打在**每一种**底色上，不能只测白底 ——
 *     亮色最难的是 --panel-3，暗色最难的也是 --panel-3。
 *   · 语义色**既当文字色也当底色**：--primary 是「白底上的蓝字」也是
 *     「配 #fff 的按钮底」；--danger 同理（.nav-item .count.warn）。
 *     只测一个方向会让另一个方向在改动后悄悄退回去。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../src/styles/legacy.css', import.meta.url));
const WHITE = '#ffffff';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rel = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (fg, bg) => { const a = rel(fg), b = rel(bg); const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };

/** 抠出一个选择器块里的 --var: #hex。背景色里有 #fff 字面量时也得认。 */
function vars(src, sel) {
  const i = src.indexOf(sel);
  if (i < 0) throw new Error('找不到选择器 ' + sel + ' —— legacy.css 的结构变了？');
  const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('}', i));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

/** 正文三档要落在每一种底色上 */
const SURFACES = ['--bg', '--panel', '--panel-2', '--panel-3', '--sidebar'];
const TIERS = ['--text', '--text-2', '--text-3'];

/** 语义色：每个都列出它**真实**会落上去的底色。多写一个不亏，少写一个就是漏网。 */
const SEMANTIC = [
  { fg: '--primary', bgs: ['--panel', '--panel-3', '--bg', '--primary-soft', '--primary-pale'], alsoWhiteText: true },
  { fg: '--danger', bgs: ['--panel', '--panel-3', '--bg', '--danger-soft'], alsoWhiteText: true },
  { fg: '--warn', bgs: ['--panel', '--panel-3', '--bg'] },
  { fg: '--ok', bgs: ['--panel', '--panel-3', '--bg'] },
];

/**
 * 已知、**故意不拦**的一条：暗色主题下「白字压在语义色上」只有 3.09 / 3.10。
 *
 * 这不是没调好，是**单色无解**：脚本枚举过整个色相不变的范围，让 --primary 既在
 * #181b22 上读得清（要够亮，≥4.5:1）又扛得住 #fff 压上来（要够暗，≥4.5:1），
 * 满足两个条件的取值有 **0 个**。--danger 同理。
 *
 * 要真正解决得动结构，三条路都要改设计、不是改数值：
 *   ① 暗色下语义色上的文字改成深色（#fff → 一个 --on-primary 变量）；
 *   ② 拆成两个变量（--primary 给文字 / --primary-bg 给底色）；
 *   ③ 接受 3:1（不合规，但很多应用就这样）。
 * 亮色没这个问题（亮色语义色本来就够深，白字压上去 5.07–5.11）。
 */
const KNOWN = (r) => /^#fff on /.test(r.label) && r.r < 4.5;

export function audit(src) {
  const rows = [];
  for (const [theme, sel] of [['亮色', ':root'], ['暗色', '[data-theme="dark"]']]) {
    const v = vars(src, sel);
    const hexOf = (k) => (k === WHITE ? WHITE : v[k]);

    for (const t of TIERS) {
      for (const s of SURFACES) {
        if (v[t] && v[s]) rows.push({ theme, group: '正文三档', label: t + ' on ' + s, fg: v[t], bg: v[s], r: ratio(v[t], v[s]) });
      }
    }
    for (const { fg, bgs, alsoWhiteText } of SEMANTIC) {
      if (!v[fg]) continue;
      for (const b of bgs) {
        if (v[b]) rows.push({ theme, group: '语义色', label: fg + ' on ' + b, fg: v[fg], bg: v[b], r: ratio(v[fg], v[b]) });
      }
      // 白色文字压在它身上（按钮底 / 计数气泡）
      if (alsoWhiteText) rows.push({ theme, group: '语义色', label: '#fff on ' + fg, fg: WHITE, bg: v[fg], r: ratio(WHITE, v[fg]) });
    }
    // 快速添加那组胶囊：fg / bg 成对预置，自动认出来
    for (const k of Object.keys(v)) {
      const m = /^--chip-(.+)fg$/.exec(k);
      const bgk = m && '--chip-' + m[1] + 'bg';
      if (bgk && v[bgk]) rows.push({ theme, group: '胶囊', label: k + ' on ' + bgk, fg: v[k], bg: v[bgk], r: ratio(v[k], v[bgk]) });
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = audit(readFileSync(CSS, 'utf8'));
  const mark = (r) => (r >= 4.5 ? '✓' : r >= 3 ? '✗ 只够大字' : '✗✗ 不足');
  let failed = 0, known = 0;

  for (const theme of ['亮色', '暗色']) {
    for (const g of ['正文三档', '语义色', '胶囊']) {
      const list = rows.filter((x) => x.theme === theme && x.group === g);
      if (!list.length) continue;
      console.log('\n' + theme + '　' + g);
      for (const r of list) {
        const ok = r.r >= 4.5, isKnown = !ok && KNOWN(r);
        if (!ok && !isKnown) failed++;
        if (isKnown) known++;
        console.log('  ' + (ok ? 'ok  ' : isKnown ? '已知' : 'FAIL') + ' ' + r.label.padEnd(30)
          + r.fg + ' / ' + r.bg + '  ' + r.r.toFixed(2).padStart(6) + '  ' + mark(r.r)
          + (isKnown ? '　单色无解，见 KNOWN 注释' : ''));
      }
    }
  }

  console.log('\n共 ' + rows.length + ' 对，不达标 ' + failed + ' 条，已知无解 ' + known + ' 条');
  process.exit(failed ? 1 : 0);
}
