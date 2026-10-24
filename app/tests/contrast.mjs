/**
 * contrast.mjs —— 锁住语义样式模块的调色板对比度。零依赖，`node tests/contrast.mjs`。
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
 *     「配 --on-primary 的按钮底」；--danger 同理（.nav-item .count.warn）。
 *     只测一个方向会让另一个方向在改动后悄悄退回去 —— 真的发生过：
 *     只测了「语义色当文字」，漏了反方向，暗色的白字压上去其实只有 3.09。
 *
 * 第二部分（见文件末尾 undefinedVars）：扫 src/ 里引用了但样式模块里
 * 没定义的变量。那是同一类错误的另一个面 —— 写错变量名 + 有兜底值 = 静默
 * 降级成写死的颜色，两套主题都不跟。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 样式目录与入口。读哪几个模块**从入口的 @import 现读**，见 styleSources()。 */
const STYLE_DIR = fileURLToPath(new URL('../src/styles/', import.meta.url));
const TW = join(STYLE_DIR, 'tailwind.css');
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const WHITE = '#ffffff';

/**
 * 按入口里 `@import "./x.css"` 的顺序读出全部语义模块并拼成一份。
 *
 * 顺序有语义：`:root` / `[data-theme]` / `[data-style]` 三者特异度相同，
 * 风格轴是靠**源码顺序**压过深浅轴的。拼错顺序会让 vars() 抠到错的那个块。
 */
export function styleSources() {
  const list = [...readFileSync(TW, 'utf8')
    .matchAll(/@import\s+"\.\/([\w.-]+\.css)"/g)].map((m) => m[1]);
  if (!list.length) throw new Error('tailwind.css 里没读到 @import "./*.css" —— 入口结构变了？');
  return list.map((file) => ({ file, src: readFileSync(join(STYLE_DIR, file), 'utf8') }));
}

/** 全部语义模块拼成一份，等价于拆分之前的那一整份样式 */
export function readStyles() {
  const parts = styleSources();
  return { files: parts.map((p) => p.file), src: parts.map((p) => p.src).join('\n') };
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rel = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (fg, bg) => { const a = rel(fg), b = rel(bg); const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };

/** 抠出一个选择器块里的 --var: #hex。背景色里有 #fff 字面量时也得认。 */
function vars(src, sel) {
  const i = src.indexOf(sel);
  if (i < 0) throw new Error('找不到选择器 ' + sel + ' —— 语义样式模块的结构变了？');
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
  { fg: '--primary', bgs: ['--panel', '--panel-3', '--bg', '--primary-soft', '--primary-pale'], onIt: true },
  { fg: '--danger', bgs: ['--panel', '--panel-3', '--bg', '--danger-soft'], onIt: true },
  { fg: '--warn', bgs: ['--panel', '--panel-3', '--bg'] },
  { fg: '--ok', bgs: ['--panel', '--panel-3', '--bg'] },
];

/**
 * 压在语义色上的文字色。**亮色白、暗色近黑** —— 暗色的 --primary (#6d8bff) 是个亮蓝，
 * 白字只有 3.09，枚举证明单色无解（见 styles/tokens.css 头部那段）。所以多一个变量。
 */
export const ON_ACCENT = '--on-primary';

/**
 * 非文本对比（WCAG 1.4.11）：**控件描边要求 3:1，不是 4.5:1**。
 *
 * 这是和上面那条**不同的线**，混在一起会两头错：拿 4.5 去卡描边会把界面
 * 变得像表格线，拿 3 去卡正文又会让小字糊掉。所以每一行自带一个 `min`。
 *
 * 为什么 --input 必须过 3:1：它是输入框 / 下拉 / 勾选圈 / 幽灵按钮的**全部**
 * 可见边界。勾选圈尤其要紧 —— 20px 的空圈只有它自己说明「这里能点」，
 * 而这个应用是给家里长辈用的。旧值亮 #d9dce6 只有 1.37，暗 #343b48 只有 1.53。
 *
 * 底色要列全：输入框会落在 --panel（白卡片）也落在 --panel-2（嵌套一格），
 * --panel-3 是最难的那档，一并算上。
 */
const NONTEXT = [
  { fg: '--input', bgs: ['--panel', '--panel-2', '--panel-3', '--bg'] },
];

const walkTree = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkTree(join(d, e.name)) : [join(d, e.name)]));

/**
 * **运行时由 JS 写进去的变量**：style 对象的键（`'--card-px': …`）和
 * `setProperty('--kb', …)`。样式模块里搜不到它们，但它们确实有定义 —— 定义在运行时。
 *
 * 原先这里是一份手写的名单，写着写着就漏（`--ev-title-lh` / `--ev-time-lh` 这一轮
 * 就没进去，于是守卫把两条真在用的变量报成「未定义」）。改成从 .tsx 里认，就不会再漏。
 */
export function runtimeVars() {
  const out = new Set();
  for (const f of walkTree(SRC).filter((f) => /\.tsx?$/.test(f))) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/['"](--[\w-]+)['"]\s*:/g)) out.add(m[1]);
    for (const m of s.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)) out.add(m[1]);
  }
  return out;
}

/** 同一份名单给 fallbackVars 用（那些变量的 CSS 兜底值就是它们的真默认值） */
const RUNTIME_SET = runtimeVars();

/**
 * 扫 `src/` 里所有 `var(--x)`，报出语义样式模块 / tailwind.css 里**没有定义**的那些。
 *
 * 为什么要锁：新 surface（登录页 / 浮层 / Btn）原先写的是
 * `var(--accent,#4f7cff)` / `var(--card,#fff)` / `var(--line,…)` 这一批，
 * 而 --accent / --accent-soft / --card / --chip / --hover / --line
 * **一个都没有定义** —— 有兜底值，所以不报错、不白屏，只是**两套主题下全是
 * 写死的颜色**：主按钮压白字 3.70:1，暗色也没跟着 --primary 走。
 * 静默降级比直接坏掉难查得多，所以这里给它一条会响的线。
 */
export function undefinedVars() {
  const defs = new Set();
  const files = [...styleSources().map((p) => join(STYLE_DIR, p.file)), TW];
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) defs.add(m[1]);

  const used = new Map();
  for (const f of walkTree(SRC).filter((f) => /\.(tsx?|css)$/.test(f))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/var\((--[\w-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(f.slice(SRC.length + 1));
    }
  }
  return [...used].filter(([k]) => !defs.has(k) && !RUNTIME_SET.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => ({ name, files: [...files].sort() }));
}

/**
 * 第二道：`.tsx` 里的 `var(--x, 兜底值)` 里的兜底值**一律是多余的**。
 *
 * 组件里的变量全部来自语义样式模块（或 JS 内联那两个），所以兜底值永远不会生效；
 * 它唯一的作用是**把「变量名写错了」变成静默降级**。上面那六个别名就是这么活下来的：
 * 名字是错的，兜底值是写死的浅色，于是两套主题下都用自己的兜底值在跑，
 * 谁也没发现。CSS 里的兜底值不一样（`var(--cols, 1)`）—— 那个是真默认值，不在此列。
 */
export function fallbackVars() {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const out = [];
  for (const f of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/var\((--[\w-]+)\s*,[^)]*\)/g)) {
      // RUNTIME_SET 里的那几个和 CSS 里的兜底值是同一回事：**那个兜底就是真默认值**
      // （没软键盘时 --kb 本来就该是 0、卡高还没量到时 --card-px 本来就该回落），
      // 不是「变量名写错了在静默降级」。名单从 .tsx 自己认出来，见 runtimeVars。
      if (RUNTIME_SET[m[1]]) continue;
      out.push({ name: m[1], files: [f.slice(SRC.length + 1)], snippet: m[0] });
    }
  }
  return out;
}

/**
 * 第三道：`.tsx` 里不许出现 Tailwind 自带的圆角工具类（`rounded` / `rounded-lg`
 * / `rounded-2xl` …）。它们写死像素，切到 flat（零圆角）/ notion（小圆角）时
 * 原地不动 —— 和上面那两类一样，不报错、不崩，只是「这一块没跟着风格走」。
 * 圆角一律走 `rounded-[var(--r-md)]` 这种写法（`rounded-` 接一个 `var()` 任意值，
 * 值取 `--r-xs` 到 `--r-pill` 那一档）。
 *
 * **注释里也别写占位符**：Tailwind 的扫描器是裸文本匹配，注释里的示例照样被当成
 * 真类名 —— 早先这里用星号当通配（`rounded-` 接 `var(--r-` 三个横杠一个星号）写过
 * 一次，构建就报两条 `Unexpected token` 警告，还生成了两条**非法** CSS。
 * 要举例就写个真令牌，别写占位符。
 */
export function roundedClasses() {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const out = [];
  for (const f of walk(SRC).filter((f) => /\.tsx$/.test(f))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // 带 `var(` 任意值的是我们要的写法；`rounded-full` 是正圆/胶囊，不算
      for (const m of line.matchAll(/\brounded(?:-[a-z0-9]+|-\[[^\]]*\])*/g)) {
        const cls = m[0];
        if (cls.includes('[var(') || cls === 'rounded-full' || cls === 'rounded-none') continue;
        out.push({ file: f.slice(SRC.length + 1), line: i + 1, cls, text: line.trim().slice(0, 70) });
      }
    });
  }
  return out;
}

export function audit(src) {
  const rows = [];
  for (const [theme, sel] of [['亮色', ':root'], ['暗色', '[data-theme="dark"]']]) {
    const v = vars(src, sel);

    for (const t of TIERS) {
      for (const s of SURFACES) {
        if (v[t] && v[s]) rows.push({ theme, group: '正文三档', label: t + ' on ' + s, fg: v[t], bg: v[s], r: ratio(v[t], v[s]) });
      }
    }
    for (const { fg, bgs, onIt } of SEMANTIC) {
      if (!v[fg]) continue;
      for (const b of bgs) {
        if (v[b]) rows.push({ theme, group: '语义色', label: fg + ' on ' + b, fg: v[fg], bg: v[b], r: ratio(v[fg], v[b]) });
      }
      // 压在它身上的文字色（按钮底 / 计数气泡 / 选中态）
      if (onIt && v[ON_ACCENT]) rows.push({ theme, group: '语义色', label: ON_ACCENT + ' on ' + fg, fg: v[ON_ACCENT], bg: v[fg], r: ratio(v[ON_ACCENT], v[fg]) });
    }
    // 非文本：控件描边。**min 是 3**，见 NONTEXT 上面那段
    for (const { fg, bgs } of NONTEXT) {
      if (!v[fg]) continue;
      for (const b of bgs) {
        if (v[b]) rows.push({ theme, group: '控件描边', label: fg + ' on ' + b, fg: v[fg], bg: v[b], r: ratio(v[fg], v[b]), min: 3 });
      }
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, src } = readStyles();
  console.log('读到的语义样式模块：' + files.join(' → '));
  const rows = audit(src);
  /** 每行自带下限：正文 4.5（1.4.3），控件描边 3（1.4.11）。见 NONTEXT 上面那段。 */
  const floor = (r) => r.min ?? 4.5;
  const mark = (r) => { const m = floor(r); return r.r >= m ? '✓' : r.r >= m - 1.5 ? '✗ 差一点' : '✗✗ 不足'; };
  let failed = 0;

  for (const theme of ['亮色', '暗色']) {
    for (const g of ['正文三档', '语义色', '控件描边']) {
      const list = rows.filter((x) => x.theme === theme && x.group === g);
      if (!list.length) continue;
      console.log('\n' + theme + '　' + g + (g === '控件描边' ? '（下限 3:1，WCAG 1.4.11）' : ''));
      for (const r of list) {
        const ok = r.r >= floor(r);
        if (!ok) failed++;
        console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + r.label.padEnd(30)
          + r.fg + ' / ' + r.bg + '  ' + r.r.toFixed(2).padStart(6) + '  ' + mark(r));
      }
    }
  }

  // ---- 第二部分：引用了但没定义的 CSS 变量 ----
  const stale = undefinedVars();
  console.log('\n未定义的 CSS 变量');
  if (!stale.length) console.log('  ok   一个都没有');
  for (const { name, files } of stale) {
    failed++;
    console.log('  FAIL ' + name.padEnd(22) + files.join(', '));
  }

  // ---- 第三部分：.tsx 里多余的兜底值（会把写错的变量名藏起来） ----
  const fb = fallbackVars();
  console.log('\n.tsx 里多余的 var() 兜底值');
  if (!fb.length) console.log('  ok   一个都没有');
  for (const { name, files, snippet } of fb) {
    failed++;
    console.log('  FAIL ' + name.padEnd(22) + files[0] + '   ' + snippet);
  }

  // ---- 第四部分：.tsx 里 Tailwind 自带的圆角类（切风格时不会跟着动） ----
  const rd = roundedClasses();
  console.log('\n.tsx 里 Tailwind 自带的圆角类');
  if (!rd.length) console.log('  ok   一个都没有');
  for (const { file, line, cls, text } of rd) {
    failed++;
    console.log('  FAIL ' + cls.padEnd(22) + file + ':' + line + '   ' + text);
  }

  console.log('\n共 ' + rows.length + ' 对，不达标 ' + failed + ' 条');
  process.exit(failed ? 1 : 0);
}
