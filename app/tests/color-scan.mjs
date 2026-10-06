/**
 * color-scan.mjs —— 锁住 legacy.css 里「颜色 / 圆角 / 阴影不许写死」这条。
 * 零依赖，`node tests/color-scan.mjs`。
 *
 * 为什么值得单独一个脚本：外观是三轴的（深浅 × 色板 × 风格），而三个轴**全靠
 * 改 CSS 变量**。规则区里只要漏一处写死的 px 或 #fff，那一处在切色板时就会
 * 赖在原地不动 —— 而且它不报错、不崩，只是「这一个按钮没跟着变」，
 * 靠肉眼在 6 套色板 × 3 种风格 × 2 档深浅 = 36 种组合里找，等于找不到。
 *
 * 所以判据放在**规则区**：令牌块自己当然可以写死值（那是它们的职责），
 * 令牌块**之外**一个都不许有。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../src/styles/legacy.css', import.meta.url));

/** 令牌块的选择器长这样。这些块里的写死值是**本分**，要跳过 */
const TOKEN_BLOCK = /(^|,)\s*(:root|\[data-(theme|accent|style)[^\]]*\])\s*$/;

/**
 * 把源码拆成「令牌块」与「规则区」两半。
 * 逐字符扫，靠花括号配平判断块边界 —— 不用正则是因为嵌套块（@media 里还有块）
 * 会把朴素的正则切法切错，而切错了这个脚本就变成永远绿的摆设。
 */
export function split(src) {
  let depth = 0, start = 0, tokens = '', rules = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') {
      if (depth === 0) {
        const sel = src.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        var isToken = TOKEN_BLOCK.test(sel);
      }
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        (isToken ? (tokens += src.slice(start, i + 1)) : (rules += src.slice(start, i + 1)));
        start = i + 1;
      }
    }
  }
  return { tokens, rules };
}

/** 规则区里不许出现的东西。[找什么, 正则, 说明] —— 正则按**声明值**判，不按整行 */
const BANNED = [
  // 值里带 px 又没引用 var() 的圆角。`50%` 与 `0` 是正圆 / 方角，不算写死
  ['写死的圆角', /border-radius:\s*([^;{}]*)/g,
    (v) => /\d+px/.test(v) && !v.includes('var('), '改引用 --r-xs/sm/md/lg/xl/pill'],
  ['主色上的白字', /\bcolor:\s*#fff\b/gi, null, '改 color: var(--primary-fg)'],
  ['旧主色的 RGB', /rgba\(74,\s*108,\s*247/g, null, '改用 rgb(from var(--primary) r g b / a)'],
  ['写死的紫', /#7b53d8/gi, null, '改 var(--purple)'],
  ['写死的暗色占用底纹', /#1a1f2b/gi, null, '停掉那条覆盖，.tl-busy 用 var(--primary-pale)'],
];

/** 令牌块里必须存在的变量 */
const REQUIRED = [
  '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-pill',
  '--primary-fg', '--danger-fg', '--toast-bg', '--toast-fg', '--toast-link',
  '--font', '--shadow-up', '--shadow-up-sm', '--shadow-sticky',
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = readFileSync(CSS, 'utf8');
  const { tokens, rules } = split(src);

  if (!tokens.length) {
    console.error('没抠出任何令牌块 —— 选择器写法变了？脚本切错了等于没测。');
    process.exit(1);
  }

  let failed = 0;
  console.log('规则区里的写死值（断言为零）');
  for (const [name, re, filter, how] of BANNED) {
    const hits = [...rules.matchAll(re)].filter((m) => !filter || filter(m[1]));
    const tag = hits.length ? 'FAIL' : 'ok  ';
    if (hits.length) failed++;
    console.log('  ' + tag + ' ' + name.padEnd(14) + String(hits.length).padStart(3) + ' 处   ' +
      (hits.length ? '→ ' + how : ''));
  }

  console.log('\n令牌块里的必需变量');
  for (const v of REQUIRED) {
    const ok = new RegExp('(^|[\\s;{])' + v + ':').test(tokens);
    if (!ok) failed++;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + v);
  }

  // 风格轴靠**源码顺序**压过 :root 与 [data-theme]（三者特异度都是 (0,1,0)）。
  // 排到前面的话不报错、不崩，只是 flat+暗色还留着暗色档那套阴影 —— 最难查的半生效。
  //
  // 只在**令牌块**里比：规则区还有 `[data-theme="dark"] .tabbar {…}` 这种，
  // 拿整份源码找 lastIndexOf 会命中它，判据恒假（第一版就是这么假失败的）。
  // 注释也要剥掉 —— 这段说明自己就写着 `[data-theme="dark"]` 这几个字。
  const bareTokens = tokens.replace(/\/\*[\s\S]*?\*\//g, '');
  const darkAt = bareTokens.lastIndexOf('[data-theme="dark"]');
  const styleAt = bareTokens.indexOf('[data-style=');
  // 两个都要命中，否则 lastIndexOf 返回 -1、判据会**恒真** —— 那是比恒假更坏的哑弹
  const order = darkAt >= 0 && styleAt >= 0 && styleAt > darkAt;
  if (!order) failed++;
  console.log('\n[data-style] 排在所有 [data-theme] 令牌块之后：' + (order ? 'ok' : 'FAIL'));
  if (!order) console.log('    → 顺序反了 / 有一边没抠出来（' + darkAt + ' vs ' + styleAt + '），flat 会压不住暗色档的 --shadow*');

  // 只报告：还没走 --shadow* 的中性阴影。它们的几何各不相同，映射不干净，
  // 但风格轴靠 --shadow* 归零，所以漏一个，扁平风格就少平一处。
  // 判据按**值**取（`/box-shadow:\s*([^;}]*)/` 再过滤），别用 `(?!var\()`：
  // 前面的 `\s*` 会回溯到零字符，于是 `var(--shadow)` 也被判成「没走令牌」。
  const shadows = [...rules.matchAll(/box-shadow:\s*([^;}]*)/g)].map((m) => m[1].trim());
  const neutral = shadows.filter((v) => !/^var\(--shadow|^none$|^inset|^rgb\(/.test(v));
  console.log('\n未走 --shadow* 的中性阴影（只报告，需人工判断）：' + neutral.length + ' 处');
  for (const v of neutral) console.log('    ' + v);

  console.log('\n不达标 ' + failed + ' 条');
  process.exit(failed ? 1 : 0);
}
