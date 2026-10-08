/**
 * color-scan.mjs —— 锁住语义样式模块里「颜色 / 圆角 / 阴影不许写死」这条。
 * 零依赖，`node tests/color-scan.mjs`。
 *
 * 读哪几个文件**从 `styles/tailwind.css` 的 `@import` 现读**，不写死清单：
 * 样式拆成模块之后，写死清单的结果是「加了新模块没人回来补」——
 * 而漏掉的那个模块就变成了没人锁的空白区，正是这个脚本要防的那种错。
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
import { join } from 'node:path';

/** 样式目录与入口。入口自己也算「新表面」，单独扫一遍（它没有令牌块）。 */
const STYLE_DIR = fileURLToPath(new URL('../src/styles/', import.meta.url));
const NEW_SURFACES = join(STYLE_DIR, 'tailwind.css');

/**
 * 按入口里 `@import "./x.css"` 的**出现顺序**读出全部语义模块。
 *
 * 顺序不能乱：风格轴靠源码顺序压过 `:root` 与 `[data-theme]`（三者特异度都是
 * (0,1,0)），拼错顺序会让下面的先后判断失真 —— 那正是这个脚本要锁的东西之一。
 */
export function styleSources() {
  const list = [...readFileSync(NEW_SURFACES, 'utf8')
    .matchAll(/@import\s+"\.\/([\w.-]+\.css)"/g)].map((m) => m[1]);
  if (!list.length) throw new Error('tailwind.css 里没读到 @import "./*.css" —— 入口结构变了？');
  return list.map((file) => ({ file, src: readFileSync(join(STYLE_DIR, file), 'utf8') }));
}

/** 拼成一份，等价于拆分之前的那一整份样式 */
export function readStyles() {
  const parts = styleSources();
  return { files: parts.map((p) => p.file), src: parts.map((p) => p.src).join('\n') };
}

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
  // 全边边框写死 1px 就绕过了风格轴 —— flat 那一档的「2px 硬边框」全靠
  // --border-w，写死的那一处会原地不动。`transparent` 的占位边框豁免
  // （它不参与视觉、只撑尺寸），单边的 `border-left: 1px solid` 也豁免
  // （那是分隔线，不跟风格轴走），所以这里只盯 `border:` 这个全边简写
  ['写死的边框宽度', /\bborder:\s*([^;{}]*)/g,
    (v) => /\b1px\s+solid/.test(v) && !v.includes('transparent'), '全边边框改 var(--border-w)'],
  ['主色上的白字', /\bcolor:\s*#fff\b/gi, null, '改 color: var(--on-primary)'],
  ['旧主色的 RGB', /rgba\(74,\s*108,\s*247/g, null, '改用 rgb(from var(--primary) r g b / a)'],
  ['写死的紫', /#7b53d8/gi, null, '改 var(--purple)'],
  ['写死的暗色占用底纹', /#1a1f2b/gi, null, '停掉那条覆盖，.tl-busy 用 var(--primary-pale)'],
];

/** 令牌块里必须存在的变量 */
const REQUIRED = [
  '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-pill',
  '--on-primary', '--input', '--toast-bg', '--toast-fg', '--toast-link',
  '--font', '--shadow-up', '--shadow-up-sm', '--shadow-sticky', '--border-w',
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, src } = readStyles();
  console.log('读到的语义样式模块：' + files.join(' → '));
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

  // tailwind.css（新表面）—— 没有令牌块（令牌全在 tokens.css），所以拿同一份
  // BANNED 直接扫整份文件。之前它完全没人锁：写死的圆角和 1px 边框可以随便长，
  // 而它们恰恰是切 flat / notion 时不会跟着动的那一批。
  const tw = readFileSync(NEW_SURFACES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  console.log('\ntailwind.css（新表面）里的写死值');
  for (const [name, re, filter, how] of BANNED) {
    const hits = [...tw.matchAll(re)].filter((m) => !filter || filter(m[1]));
    const tag = hits.length ? 'FAIL' : 'ok  ';
    if (hits.length) failed++;
    console.log('  ' + tag + ' ' + name.padEnd(14) + String(hits.length).padStart(3) + ' 处   ' +
      (hits.length ? '→ ' + how : ''));
  }
  // 兜底值和语义模块那边一个道理：新表面的变量同样来自 tokens.css，
  // 兜底值唯一的作用是把「变量名写错了」变成静默降级的写死浅色。
  // `--kb` 例外 —— 没软键盘时它就该是 0，那是真默认值。
  const fb = [...tw.matchAll(/var\((--[\w-]+)\s*,[^)]*\)/g)].filter((m) => m[1] !== '--kb');
  if (fb.length) failed++;
  console.log('  ' + (fb.length ? 'FAIL' : 'ok  ') + ' 多余的 var() 兜底值  ' + fb.length + ' 处   ' +
    (fb.length ? '→ 只留 var(--x)' : ''));

  console.log('\n不达标 ' + failed + ' 条');

  // 扫描 .tsx 文件里的原生 <select> 元素
  // 项目约定：零原生 <select>，一律用 Dropdown / Chips / SheetPicker 替代
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const { readdirSync, statSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');

  function findTsx(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
      const full = joinPath(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...findTsx(full));
      } else if (entry.endsWith('.tsx')) {
        results.push(full);
      }
    }
    return results;
  }

  const tsxFiles = findTsx(SRC);
  let selectCount = 0;
  console.log('\n.tsx 文件里的原生 <select>（断言为零）');
  for (const file of tsxFiles) {
    let content = readFileSync(file, 'utf8');
    // 去掉注释和模板字符串里的 <select>，避免误报
    content = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      .replace(/`[^`]*`/g, '');
    const matches = content.match(/<select[\s>]/g);
    if (matches) {
      selectCount += matches.length;
      const rel = file.replace(SRC, 'src');
      console.log('  FAIL ' + rel + '  ' + matches.length + ' 处');
    }
  }
  if (selectCount === 0) {
    console.log('  ok    0 处');
  } else {
    failed++;
    console.log('  → 改用 Dropdown<K>（少量固定选项）/ Chips<K>（选项要一直看得见）/ SheetPicker<K>（动态或大量选项）');
  }

  console.log('\n不达标 ' + failed + ' 条');
  process.exit(failed ? 1 : 0);
}
