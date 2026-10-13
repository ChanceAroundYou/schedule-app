/**
 * api-scan.mjs —— 锁「样式归属三层」（第 1 册 R1–R5）里能**静态**锁住的那几条。
 * 零依赖，`node tests/api-scan.mjs`。
 *
 * 锁三条，各对应一条不变量：
 *
 *   1. `domain/` 零 Tailwind 外观类 —— D1 纯净。domain 不含 React / DOM / 网络，
 *      连样式都不该碰，出现 `bg-[var(…)]` 就是分层破了。
 *   2. `views/` 零 Tailwind 外观类 —— D2 冻结。views 是纯展示，只用语义类
 *      （`.task-row` / `.nav-item` 那批），外观归 `styles/` 与 kit。
 *   3. `ui/` 调用方（**非 kit**）+ `app/` 的外观类**只减不增** —— R4 的方向。
 *
 * 为什么第 3 条是「只减不增」而不是「必须为零」：
 *   本项目既有的正确写法就是「调用方用 Tailwind 工具类 + CSS 变量」——
 *   CLAUDE.md 三、界面硬规则 里 `rounded-[var(--r-md)]` / `text-[var(--text-2)]`
 *   本身就是**推荐**写法，不是违规。把调用方一步清零等于重写整个 UI 层，
 *   不在第一册 S1–S7 的范围。所以这里锁的是「不许再往调用方**加**」：
 *   `CALLER_BASELINE` 是冻结的上限，要刻意新增就改这里的数字并写清理由——
 *   那等于承认 R4 又退了一步，得有人点头。
 *
 * 外观类口径（与 plan 一致，四条轴）：`rounded-[var(` / `bg-[var(` /
 * `text-[var(` / `border-[var(`。`text-[13px]`（字号）/ `border-[length:var(…)]`
 * （线宽）不含 `var(` 紧随 `[`，不在此列——它们不是「写死外观」。
 *
 * 豁免：`ui/kit/**`（外观的合法宿主，R4 明许，kit 内部照写）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const APPEARANCE = /\b(?:rounded|bg|text|border)-\[var\(/g;

/** 调用方（`ui/` 非 kit + `app/` + 根）外观类的冻结上限。只减不增。 */
const CALLER_BASELINE = 73;

/** 递归收集 `dir` 下所有以 `exts` 结尾的文件 */
function listFiles(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** 去掉注释与模板串，避免注释 / 文档里提到类名被误计 */
function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`[^`]*`/g, '');
}

function count(file) {
  return [...strip(readFileSync(file, 'utf8')).matchAll(APPEARANCE)].length;
}

const rel = (p) => p.replace(SRC, 'src');
let failed = 0;

/** 硬锁：这批文件外观类必须为零，任何一处都算破 */
function lockZero(label, files) {
  console.log('\n' + label + '（断言为零）');
  let hits = 0;
  for (const f of files) {
    const n = count(f);
    if (n) {
      hits += n;
      console.log('  FAIL ' + rel(f) + '  ' + n + ' 处');
    }
  }
  if (hits === 0) console.log('  ok    0 处');
  else {
    failed++;
    console.log('  → 外观归 styles/ 与 kit，这层不该出现 Tailwind 外观类');
  }
}

// 1. domain/ 纯净（.ts 与 .tsx 都算）
lockZero('domain/ 纯净（D1）', listFiles(join(SRC, 'domain'), ['.ts', '.tsx']));

// 2. views/ 冻结（纯展示，语义类）
lockZero('views/ 冻结（D2）', listFiles(join(SRC, 'views'), ['.tsx']));

// 3. 调用方外观类只减不增（R4 方向）
const callers = listFiles(SRC, ['.tsx']).filter(
  (f) => !f.includes(join('ui', 'kit')) && !f.includes(join('views')),
);
console.log('\n调用方外观类（ui/ 非 kit + app/ + 根，只减不增）');
let total = 0;
const over = [];
for (const f of callers) {
  const n = count(f);
  total += n;
  if (n) over.push('  ' + rel(f) + '  ' + n);
}
console.log('  当前 ' + total + ' / 上限 ' + CALLER_BASELINE);
if (total > CALLER_BASELINE) {
  failed++;
  console.log('  FAIL 超出上限 ' + (total - CALLER_BASELINE) + ' 处：');
  console.log(over.join('\n'));
  console.log('  → 新外观进 kit 一处，别散进调用方；确要新增改 CALLER_BASELINE 并说明理由');
}

console.log('\n不达标 ' + failed + ' 条');
process.exit(failed ? 1 : 0);
