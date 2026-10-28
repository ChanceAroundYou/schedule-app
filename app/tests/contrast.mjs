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

/**
 * 日程集颜色轴的八支（`[data-cal-color="…"]`），每支两个值：
 *   · `--cal-color` 实色 —— 色板按钮、侧栏圆点
 *   · `--cal-band` 淡档 —— 卡片左沿那条 3px 竖线（jade 那一档是 `transparent`）
 *
 * 它们不在 `:root` 里，`vars()` 抠不到，所以要单独一路。值有四种写法：
 * 6 位 hex、8 位 hex（自带 alpha）、`var(--primary)`、`transparent`。
 * 后两种必须解析/判定成当前主题的实际值 —— 否则这八条会**静默不测**，
 * 守卫看起来全绿、其实少测了一整组。
 *
 * 暗色档是**后代**选择器（`[data-theme="dark"] [data-cal-color="…"]`，中间有空格 ——
 * 两个属性不在同一个元素上，连写的复合选择器谁都不匹配），用后顾排除法把亮色那八条摘出来。
 */
function calVars(src, dark) {
  const re = dark
    ? /\[data-theme="dark"\]\s*\[data-cal-color="(\w+)"\]\s*\{([^}]*)\}/g
    : /(?<!\[data-theme="dark"\]\s*)\[data-cal-color="(\w+)"\]\s*\{([^}]*)\}/g;
  const out = {};
  for (const m of src.matchAll(re)) {
    const one = {};
    for (const p of m[2].matchAll(/(--cal-(?:color|band)):\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|var\(--[\w-]+\)|transparent)/g)) {
      one[p[1]] = p[2];
    }
    out[m[1]] = one;
  }
  return out;
}

/**
 * 带 alpha 的前景要**先按它落上去的底色合成**再算比值。
 *
 * 直接把 8 位 hex 当前景等于把 alpha 那层当成不透明 —— 算出来的比值虚高，
 * 「淡到看不见」的那种改法就抓不住了。合成后才是眼睛真正看到的颜色。
 */
function overBg(fg, bg) {
  if (fg.length !== 9) return fg;
  const a = parseInt(fg.slice(7, 9), 16) / 255;
  const f = [1, 3, 5].map((i) => parseInt(fg.slice(i, i + 2), 16));
  const b = hex(bg).map((c) => c * 255);
  const to2 = (c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0');
  return '#' + f.map((c, i) => to2(a * c + (1 - a) * b[i])).join('');
}

/** 正文三档要落在每一种底色上 */const SURFACES = ['--bg', '--panel', '--panel-2', '--panel-3', '--sidebar'];
const TIERS = ['--text', '--text-2', '--text-3'];

/**
 * **卡片时间行专用灰**（2026-10-25）。
 *
 * `.ev-time` 用的是 `--text-3-soft`（比 `--text-3` 再灰一档，用户：「时间字体
 * 灰一点」），它**只落在卡片自己的底色上**，所以不能塞进上面的 TIERS ——
 * 那一组是「每种底色都要过」的正文三档，混进来会要求它在 --bg / --sidebar
 * 上也达标，而那些地方根本没有卡片。
 *
 * 卡片的时间行落在**两种**底色上，别的一个都没有：
 *   · 常态卡 / 月胶囊 / 拖拽分身 —— `--primary-pale`（每个色板一个值，六个都要查）
 *   · 已完成卡 —— `--panel-3`
 *
 * ⚠️ **`--primary-soft` 不在这里**，虽然它也是强调色：那上面出现的是 `.drag-range`
 * （拖拽拉段的预览框），它不挂 `.task-el`、只渲染一个时刻文字（吃 `--text-2`），
 * 根本没有 `.ev-time`。加进来会造一条**假失败** —— 暗色的 `#948f87 / #1a2e27`
 * 只有 4.47，看着像真问题（2026-10-25 就这么误报过一次）。
 * 判据是「这个底色上真的会画这一行字吗」，不是「这个颜色看着像卡片底色」。
 */
const CARD_SURFACES = ['--primary-pale', '--panel-3'];

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

/**
 * 日程集色带（卡片左沿那条淡带）的**区间**，两端都要锁。
 *
 * 下限 1.15：再淡就等于这条带不存在 —— 「任务按来源集上色」这件事白做。
 * 上限 2.5：再浓就是「贴了块胶带」（用户 2026-10-28 原话否掉的方向）。
 * 两头都有人会在改的时候顺手越过，所以不写「够淡就行」。
 */
const BAND_LO = 1.15, BAND_HI = 2.5;

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
    /* 时间行那一档灰：只查它**真实**会落上去的卡片底色（见 CARD_SURFACES） */
    for (const b of CARD_SURFACES) {
      if (v['--text-3-soft'] && v[b]) {
        rows.push({
          theme, group: '卡片时间行', label: '--text-3-soft on ' + b,
          fg: v['--text-3-soft'], bg: v[b], r: ratio(v['--text-3-soft'], v[b]),
        });
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
    /* 日程集颜色轴八支的**实色**：今天它只当图形用（色板按钮、侧栏圆点），
       但这一组故意留在 4.5 不放宽 —— 以后谁把它当文字色用（抽屉里写「来自某集」
       那种），这条线要立刻拦住，而不是放过去再回头查。 */
    const cal = calVars(src, theme === '暗色');
    for (const [key, one] of Object.entries(cal)) {
      for (const b of CARD_SURFACES) {
        if (!v[b] || !one['--cal-color']) continue;
        rows.push({ theme, group: '日程集颜色', label: `--cal-color(${key}) on ${b}`, fg: one['--cal-color'], bg: v[b], r: ratio(one['--cal-color'], v[b]) });
      }
      /* 淡档那条 3px 竖线。2026-10-28 用户两次裁决：「小竖线不要给明显的颜色，
         通通用浅色」「和主题色一致的时候能实现完全消失」—— 所以这一组锁的是
         **区间**，不是 3:1 下限：
           · jade 必须正好是 `transparent`：默认集那条带要**完全消失**，
             画成「很淡的一条」也算失败（用户要的是没有，不是浅）。
           · 其余七支：合成后对卡底 1.15 ≤ 比值 ≤ 2.5。低于下限等于这条带不存在
             （集颜色那件事就没做了），高于上限就是「贴胶带」。
         为什么这里**故意不套** WCAG 1.4.11 的 3:1：那条针对「识别内容所必需的
         视觉内容」，而这条带是次要的冗余着色 —— 同一件事在侧栏圆点（实色
         `--cal-color`）和卡上的来源 tag 上各说一遍。做淡是设计意图。 */
      const raw = one['--cal-band'];
      if (key === 'jade') {
        const gone = raw === 'transparent';
        rows.push({ theme, group: '日程集色带', label: '--cal-band(jade) 要完全消失', fg: raw ?? '(没写)', bg: '—', r: gone ? 1 : 0, min: 1 });
        continue;
      }
      for (const b of CARD_SURFACES) {
        if (!v[b] || !raw) continue;
        const fg = raw.startsWith('var(') ? v[raw.slice(4, -1)] : raw;
        if (!fg) {
          rows.push({ theme, group: '日程集色带', label: `--cal-band(${key}) = ${raw} 解析不到`, fg: raw, bg: v[b], r: 0, min: BAND_LO, max: BAND_HI });
          continue;
        }
        const over = overBg(fg, v[b]);
        rows.push({ theme, group: '日程集色带', label: `--cal-band(${key}) on ${b}`, fg: over, bg: v[b], r: ratio(over, v[b]), min: BAND_LO, max: BAND_HI });
      }
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
  /** 每行自带下限：正文 4.5（1.4.3），控件描边 3（1.4.11），色带是一个**区间**。见 NONTEXT / BAND_LO 上面那段。 */
  const floor = (r) => r.min ?? 4.5;
  const ceil = (r) => r.max ?? Infinity;
  const mark = (r) => { const m = floor(r); return r.r > ceil(r) ? '✗ 太浓' : r.r >= m ? '✓' : r.r >= m - 1.5 ? '✗ 差一点' : '✗✗ 不足'; };
  let failed = 0;

  for (const theme of ['亮色', '暗色']) {
    for (const g of ['正文三档', '卡片时间行', '语义色', '日程集颜色', '日程集色带', '控件描边']) {
      const list = rows.filter((x) => x.theme === theme && x.group === g);
      if (!list.length) continue;
      const note = g === '控件描边' ? '（下限 3:1，WCAG 1.4.11）'
        : g === '日程集色带' ? `（淡档：比值 ${BAND_LO}–${BAND_HI}，jade 须 transparent）` : '';
      console.log('\n' + theme + '　' + g + note);
      for (const r of list) {
        const ok = r.r >= floor(r) && r.r <= ceil(r);
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
