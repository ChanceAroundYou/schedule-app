/**
 * 逐格判定的单一真相源（纯函数，不依赖 page / ctx，可脱离浏览器单测）。
 * Reviewer 第 2 轮：为证明「缺视图 / 缺样本 → 违规」两条负向路径真的会 FAIL，
 * 把逐格判定 + 逐张短边契约断言抽到这里；run() 只是薄壳（打印 logs、调 ok、
 * 累加 cover）。这样能在同一矩阵文件里用临时数据做单元级故障注入，不新增项目文件。
 *
 * 入参：key/view/style（组合标识）、uiProvides（该视口 UI 是否提供该档）、
 * viewProvidesKind（该视图按真实 DOM 是否画该卡型）、cell（00 采集的格记录，
 * undefined = 漏格；含 samples[] / sampleCount / domCount（预期应显示的真实卡数）
 * / legitHiddenCount（月滑预览、拖拽分身等合理虚拟/隐藏卡，明确排除）/ totalCount）、
 * unsupportedReason（常量卡型不适用原因）、RADIUS_K / RADIUS_MIN / num。
 * 判定：预期适用格 domCount 必须 === samples.length，domCount > sampleCount
 * 即「有目标卡被隐藏/零尺寸静默漏采」→ FAIL；unsupported 仅允许常量卡型不适用。
 * 返回 { verdict, checks:[{pass,what}], logs:[str], cover:{...} }。
 */
export function evaluateCell({ key, view, style, uiProvides, viewProvidesKind,
  cell, unsupportedReason, RADIUS_K, RADIUS_MIN, num }) {
  const checks = [];
  const logs = [];
  const cover = { applicable: 0, unsupported: 0, violation: 0, missing: 0,
    cards: 0, formula: 0, flat: 0 };
  const add = (pass, what) => checks.push({ pass, what });

  if (!cell) {
    cover.missing++;
    add(false, key + ' 矩阵漏格：没有这条记录（逐格必须齐）');
    return { verdict: 'missing', checks, logs, cover };
  }

  const samples = Array.isArray(cell.samples) ? cell.samples : [];
  const expectApplicable = uiProvides && viewProvidesKind;

  if (expectApplicable) {
    // 预期适用：必须 applicable=true、无 violation、且**至少一张真实可见卡**。
    // sampleCount 与 samples 长度都要够 —— 只记数不逐张（第 1 轮的假绿）一律违规。
    const okSample = cell.applicable === true && !cell.violation
      && cell.sampleCount >= 1 && samples.length >= 1
      && cell.sampleCount === samples.length;
    if (!okSample) {
      cover.violation++;
      const why = cell.reason || ('sampleCount=' + cell.sampleCount
        + '，samples=' + samples.length + '，DOM 共 ' + cell.totalCount + ' 个');
      logs.push('[违例详情] ' + key + ' 预期适用却无真实样本 → ' + why);
      add(false, key + ' 预期适用却无真实样本（applicable=' + cell.applicable
        + '，violation=' + !!cell.violation + '，' + why + '）');
      return { verdict: 'violation', checks, logs, cover };
    }
    cover.applicable++;
    add(cell.activeView === view,
      key + ' 读数时 activeView=' + cell.activeView + '（须严格 = ' + view + '，null 不接受）');
    /* findings A：逐节点分类完整性 + 不可见直接 FAIL。00 新版 cell 带
       nodeCount / expectedCount / shadowCount / hiddenExpectedCount 四个字段；
       旧数据或既有负注入用例缺字段时用 Number.isFinite 守卫跳过，不误伤。
       · 枚举节点数必须 === expected + shadow：证明每个目标卡节点都被精确分类、
         没有一个被 closest 宽泛祖先悄悄排除（expected/domsample 完整性）；
       · expected 里不可见/零尺寸卡必须为 0：findings A 要求直接 FAIL，
         不得静默滤除成 usable 后靠 domCount>sampleCount 间接推断。 */
    if (Number.isFinite(cell.nodeCount)) {
      add(cell.nodeCount === cell.expectedCount + cell.shadowCount,
        key + ' 逐节点分类完整性：枚举 ' + cell.nodeCount + ' = expected '
        + cell.expectedCount + ' + 合法影子层 ' + cell.shadowCount + '（无宽泛祖先漏排）');
    }
    if (Number.isFinite(cell.hiddenExpectedCount)) {
      add(cell.hiddenExpectedCount === 0,
        key + ' expected 中不可见/零尺寸卡 ' + cell.hiddenExpectedCount
        + ' 张（findings A 直接 FAIL，不得静默滤除）');
    }
    /* findings A（本轮定点返工）：expected 节点真实性的**独立闭环**。
       00 采样时留三份互不相干的 ID 清单（不新增项目文件、不改编排/seed）：
         · sourceTaskIds：localStorage['schedule-app-v4'].tasks 的 key —— fixture/seed
           经 lib/seed.mjs 落库的真实任务 ID 全集，与分类函数、DOM 枚举都无关；
         · domIds：该格枚举到的**全部**目标卡节点的 DOM data-id（原始枚举，未经分类）；
         · expectedIds / shadowIds：classifyCardDescriptor 分类后的 expected / 影子层
           节点 data-id。该函数只在「自身 .drag-ghost+aria-hidden」和「明确
           .month-ghost[aria-hidden] 根下无 data-id 预览 pill」两种源码标识下返回
           shadow，其余一律 expected —— 即 ghost 判据**只排除影子层元素**，绝不吞掉
           带 data-id 的真实任务。下面用三份清单独立对账：
         ① expected 节点必须人人带真实 data-id（null/空 = 伪造或漏标 → FAIL）；
         ② expectedIds ⊆ sourceTaskIds（未知/伪造 ID → FAIL）；
         ③ expectedIds 无重复（重复 ID → FAIL）；
         ④ DOM 里「非 shadow」的真实卡 ID 逐一匹配 expectedIds（漏 ID / 多 ID /
            ID 错配 → FAIL）—— 即「非 ghost 预期任务 ID 必逐一匹配 expected」；
         ⑤ 这些真实卡 ID 也 ⊆ sourceTaskIds（DOM 不冒出未入库的卡）。
       旧数据 / 既有负注入用例缺这些字段时用 Array.isArray 守卫整段跳过，不误伤。 */
    if (Array.isArray(cell.expectedIds) && Array.isArray(cell.domIds)) {
      const isId = (x) => typeof x === 'string' && x.length > 0;
      const expIds = cell.expectedIds.filter(isId);
      const badExpected = cell.expectedIds.filter((x) => !isId(x));
      const source = Array.isArray(cell.sourceTaskIds) ? cell.sourceTaskIds : null;
      const shadow = Array.isArray(cell.shadowIds) ? cell.shadowIds : [];
      const domReal = cell.domIds.filter(isId).filter((id) => !shadow.includes(id));
      add(cell.expectedIds.length > 0 && badExpected.length === 0,
        key + ' expected 节点均带真实 data-id（ghost 判据只排除影子层，'
        + cell.expectedIds.length + ' 个 expected 中非法 ID ' + badExpected.length + ' 个）');
      if (source) {
        add(expIds.every((id) => source.includes(id)),
          key + ' expected 任务 ID 均在 fixture/localStorage 真值表内（无未知/伪造 ID；'
          + '真值表 ' + source.length + ' 个，expected ' + expIds.length + ' 个）');
        add(domReal.every((id) => source.includes(id)),
          key + ' DOM 真实卡 ID 均在 fixture 真值表内（无未入库卡）');
      }
      add(new Set(expIds).size === expIds.length,
        key + ' expected 任务 ID 无重复（' + cell.expectedIds.length + ' 个）');
      add(domReal.length === expIds.length && domReal.every((id) => expIds.includes(id)),
        key + ' 非 ghost 预期任务 ID 逐一匹配 expected：DOM 真实卡 ' + domReal.length
        + ' 个 = expected ' + expIds.length + ' 个（无漏 ID/多 ID/ID 错配）');
    }
    /* DOM 总数与可见有效样本数的关系判定（Reviewer 第 3 轮）：
       · legitHiddenCount = 00 明确分类的「合理虚拟/隐藏卡」（月滑预览 / 拖拽分身），
         按组件设计本就不该显示，已排除在 domCount 之外，只作审计；
       · domCount = 预期应显示的真实卡总数；samples.length = 可见且宽高>0 的逐张样本数；
       · 判据：domCount === samples.length。domCount > sampleCount 说明有预期目标卡
         被 display:none / 零尺寸藏掉而没进 samples —— 正是旧 totalCount >= samples.length
         恒真判定漏掉的形态，必须 FAIL。缺可见卡 / 零尺寸的预期目标卡因此无处可藏。 */
    const domCount = Number.isFinite(cell.domCount) ? cell.domCount : cell.totalCount;
    const legitHidden = Number.isFinite(cell.legitHiddenCount) ? cell.legitHiddenCount : 0;
    add(domCount === samples.length,
      key + ' 预期应显示卡 ' + domCount + ' 张 = 可见逐张样本 ' + samples.length
      + ' 张（DOM 总数 ' + cell.totalCount + '，合理虚拟/隐藏 ' + legitHidden
      + ' 张已明确排除；domCount > sampleCount 即为隐藏/零尺寸卡漏采）');

    // 逐张做短边契约断言：每张真实可见卡都受断言，不只首卡
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const card = key + ' 卡#' + (i + 1) + '/' + samples.length;
      const short = Math.min(s.h, s.w);
      // 用**这张卡自己**的 k/--r-xl/短边重算，不借首卡、不借别档
      const want = Math.min(s.rXl, Math.max(RADIUS_MIN, short * s.rK));
      add(Math.abs(s.rK - RADIUS_K) < 1e-6,
        card + ' 逐张 k(--card-r-k)=' + num(s.rK) + ' = 契约常数 ' + RADIUS_K);
      add(Math.abs(s.want - want) <= 0.02,
        card + ' want 自洽：格内记录 ' + num(s.want) + ' = 按本卡重算 ' + num(want));
      if (style === 'flat') {
        add(s.radius === 0, card + ' flat 档圆角恒 0（--r-xl=0），实际 ' + num(s.radius));
        cover.flat++;
      } else {
        const good = Math.abs(s.radius - want) <= 0.6;
        if (!good) logs.push('[违例详情] ' + card + '：圆角 ' + num(s.radius)
          + ' ≠ 短边 ' + num(short) + ' × k ' + num(s.rK) + ' 夹在 '
          + RADIUS_MIN + '~' + num(s.rXl) + ' 的 want ' + num(want)
          + '（差 ' + num(s.radius - want) + '；高 ' + num(s.h) + ' 宽 ' + num(s.w)
          + ' --card-h=' + num(s.cardH) + '）');
        add(good, card + ' 圆角 ' + num(s.radius) + ' = 短边 ' + num(short)
          + ' × ' + RADIUS_K + ' 夹在 ' + RADIUS_MIN + '~' + num(s.rXl)
          + '（want ' + num(want) + '，--card-h=' + num(s.cardH) + '）');
        cover.formula++;
      }
      const horizontal = s.w >= s.h;
      if (!horizontal) logs.push('[违例详情] ' + card + '：竖卡 w=' + num(s.w)
        + ' < h=' + num(s.h) + '，生产 --card-h 与短边契约分叉');
      add(horizontal, card + ' 短边即高度（w=' + num(s.w) + ' ≥ h=' + num(s.h)
        + '）；否则生产 --card-h 与短边契约不等价');
      cover.cards++;
    }
    return { verdict: 'applicable', checks, logs, cover };
  }

  /* 预期不适用**只认常量卡型不适用**（UNSUPPORTED_REASON[view/kind]）。
     Reviewer 第 3 轮：Topbar 无条件渲染四档按钮，批准计划确认四视图都由 UI
     无条件提供，**不存在合法的「视图级不适用」**；00 里旧的 capComplete /
     capabilityConfirmed「视图级不适用」分支已删（会把「按钮清单非空但目标缺失 /
     缺按钮」静默放行成假绿）。因此：非恒量的不适用一律判 violation + FAIL，
     不再返回 unsupported；verdict=unsupported 只可能来自常量卡型不适用。 */
  const constantOk = !!unsupportedReason && cell.constantUnsupported === true
    && cell.reason === unsupportedReason && cell.applicable === false && !cell.violation;
  if (!constantOk) {
    cover.violation++;
    logs.push('[违例详情] ' + key + ' 无合法依据的不适用（仅常量卡型不适用合法）');
    add(false, key + ' 不适用须有据（仅常量卡型不适用），实际 applicable='
      + cell.applicable + '，violation=' + !!cell.violation + '，constantUnsupported='
      + !!cell.constantUnsupported + '，reason=' + (cell.reason || '无'));
    return { verdict: 'violation', checks, logs, cover };
  }
  cover.unsupported++;
  add(true, key + ' 不适用须有据（常量卡型不适用），reason=' + cell.reason);
  return { verdict: 'unsupported', checks, logs, cover };
}

/**
 * findings viewport（本轮定点返工）：EXPECT_VIEWPORTS 与 00/编排状态同源，
 * 「viewport 配置少一档」会让期望与实际一起缩水、自证通过。这里用**本地常量**
 * 固定编排 card-geometry.mjs:45-48 的两档，作为不被 state/spec 污染的独立
 * 真相源；纯函数逐项精确核验四个来源，任一缺档 → FAIL。负注入直接 import 本函数
 * 做「删档 / 缩小期望」验证，不新增项目文件。
 */
export const EXPECTED_VP_NAMES = ['桌面 1400', '窄屏 390'];

export function evaluateViewportCoverage({ stateViewports, specExpectViewports,
  specViewports, configuredNames, viewportConfig, matrixViewsLen, stylesLen, kindsLen,
  matrixCellsByVp }) {
  const checks = [], logs = [], errors = [];
  const namesOf = (arr) => (Array.isArray(arr) ? arr : [])
    .map((v) => (typeof v === 'string' ? v : (v && v.name)))
    .filter((v) => typeof v === 'string' && v.length > 0);
  const expected = EXPECTED_VP_NAMES.slice();
  const sameSet = (got) => got.length === expected.length && expected.every((n) => got.includes(n));
  const vpCfg = viewportConfig || {};
  const cellsByVp = matrixCellsByVp || {};
  const stateNames = namesOf(stateViewports);
  const missingInState = expected.filter((n) => !stateNames.includes(n));
  if (missingInState.length) errors.push('state.VIEWPORTS 缺预期 viewport：'
    + missingInState.join('、') + '（实际 [' + stateNames.join('、') + ']）');
  checks.push({ pass: missingInState.length === 0 && stateNames.length === expected.length,
    what: 'state.VIEWPORTS 逐项精确匹配本地常量 [' + expected.join('、') + ']：实际 ['
      + stateNames.join('、') + ']，缺 ' + missingInState.length + ' 档' });
  const specExpectNames = namesOf(specExpectViewports);
  checks.push({ pass: sameSet(specExpectNames),
    what: 'spec.EXPECT_VIEWPORTS 与本地常量一致（防同源污染）：[' + specExpectNames.join('、') + ']' });
  const specNames = namesOf(specViewports);
  checks.push({ pass: sameSet(specNames),
    what: 'spec.VIEWPORTS（00 矩阵循环）与本地常量一致：[' + specNames.join('、') + ']' });
  const cfgNames = namesOf(configuredNames);
  checks.push({ pass: sameSet(cfgNames),
    what: '实际成功配置 viewport 逐项精确匹配本地常量：[' + cfgNames.join('、') + ']' });
  checks.push({ pass: cfgNames.filter((n) => expected.includes(n)).length === expected.length,
    what: '每预期 viewport 计数：本地常量 ' + expected.length + ' 档，实际成功配置命中 '
      + cfgNames.filter((n) => expected.includes(n)).length + ' 档' });
  const expectCells = matrixViewsLen * stylesLen * kindsLen;
  for (const name of expected) {
    const c = vpCfg[name];
    checks.push({ pass: !!c, what: '本地常量 viewport「' + name + '」已实际成功配置（按名字精确匹配）' });
    if (!c) { errors.push('viewport「' + name + '」未成功配置'); continue; }
    checks.push({ pass: c.metricsConfigured === true,
      what: name + ' 已成功下发 Emulation.setDeviceMetricsOverride' });
    checks.push({ pass: Array.isArray(c.viewsCompleted) && c.viewsCompleted.length === matrixViewsLen,
      what: name + ' 完成矩阵视图循环 ' + (c.viewsCompleted || []).length + '/' + matrixViewsLen
        + '（' + (c.viewsCompleted || []).join(',') + '）' });
    checks.push({ pass: Array.isArray(c.stylesCompleted) && c.stylesCompleted.length === stylesLen
        && Array.isArray(c.kindsCompleted) && c.kindsCompleted.length === kindsLen,
      what: name + ' 完成风格×卡型矩阵循环（' + (c.stylesCompleted || []).length + ' 风格 / '
        + (c.kindsCompleted || []).length + ' 卡型）' });
    checks.push({ pass: c.matrixCells === expectCells,
      what: name + ' 00 记录采格数 ' + c.matrixCells + ' = ' + expectCells });
    checks.push({ pass: cellsByVp[name] === expectCells,
      what: name + ' radiusMatrix 逐项矩阵格齐全 ' + cellsByVp[name] + '/' + expectCells });
  }
  return { checks, logs, errors };
}

/**
 * 风格签名三档成对互异判定（Reviewer round6 定点返工；纯函数，不依赖 page/ctx，
 * 可脱离浏览器被临时负注入脚本直接 import 做单元级故障注入，不新增项目文件）。
 *
 * finding：02 边界探针旧判定 `new Set(rxls).size >= 2 && new Set(bwds).size >= 2`
 * 只要求「至少两档不同」——soft/flat/notion 里任意两档 --r-xl 相同、或
 * --border-w 本来就有两档同为 1px（soft/notion，tokens.css:106/376/387），
 * 都会照样放行，证明不了三档都生效。本函数把判定收紧为「三档签名成对互异」：
 *
 * 入参 signatures[style] = { style, rXl, borderW, radius, sampleCount, hiddenCount }：
 *   · style       该档签名是在哪次 CDP 读取里采的（documentElement.dataset.style），
 *                 必须严格 === 档名，证明每档确实各自独立读取、没有复用别档数据；
 *   · rXl         该档 --r-xl 签名（边界探针取 :root computed，矩阵取真实卡 computed）；
 *   · borderW     该档 --border-w（组合签名维度；00 未采时由 02 边界探针段独立 CDP 补）；
 *   · radius      该档代表卡的真实 computed radius（getComputedStyle 读到的圆角，
 *                 不是只看 :root 变量）；
 *   · sampleCount 该档真实可见卡样本数（selector 缺样本/零样本 → 直接 FAIL）；
 *   · hiddenCount 该档被隐藏/零尺寸卡静默遗漏的张数（>0 → 直接 FAIL）。
 *
 * 判定（任一不满足 → verdict='violation'，对应 check 为 FAIL）：
 *   ① 三档签名齐全、各自 style 标记严格等于档名、--r-xl 非空（边界格固定卡没匹配 → FAIL）；
 *   ② 每档 sampleCount ≥ 1（不得让 selector 缺样本产生假通过）；
 *   ③ 每档 hiddenCount === 0（不得让 hidden 卡遗漏产生假通过）；
 *   ④ 每档代表卡有真实 computed radius（有限数值）；
 *   ⑤ --r-xl 签名 set size = 3（三档 rXl 全不同，旧 >=2 会放行任意两档相同）；
 *   ⑥ 组合签名 (--r-xl|--border-w) set size = 3（可能组合 border width）；
 *   ⑦ pairwise 三对签名互异（逐对给诊断，点名哪两档相同）；
 *   ⑧ flat 档 --r-xl=0 且代表卡 radius=0；非 flat 档代表卡 radius>0。
 * 返回 { verdict:'ok'|'violation', checks:[{pass,what}] }。
 */
export const STYLE_SIGNATURE_STYLES = ['soft', 'flat', 'notion'];

export function evaluateStyleSignatures({ key, styles, signatures }) {
  const checks = [];
  const add = (pass, what) => checks.push({ pass, what });
  const list = Array.isArray(styles) && styles.length ? styles : STYLE_SIGNATURE_STYLES;
  const src = (signatures && typeof signatures === 'object') ? signatures : {};
  const of = (s) => (src[s] && typeof src[s] === 'object') ? src[s] : null;
  const norm = (v) => (v === undefined || v === null) ? '' : String(v).trim();
  const rXlOf = (s) => norm(of(s) && of(s).rXl);
  const comboOf = (s) => rXlOf(s) + '|' + norm(of(s) && of(s).borderW);
  const allPresent = list.every((s) => {
    const g = of(s);
    return !!g && g.style === s && rXlOf(s).length > 0;
  });

  for (const s of list) {
    const g = of(s);
    add(!!g && g.style === s,
      key + ' 档「' + s + '」签名来自该档独立 CDP 读取（dataset.style='
      + (g ? JSON.stringify(g.style) : '签名缺失') + ' 须严格 = ' + JSON.stringify(s) + '）');
    add(!!g && rXlOf(s).length > 0,
      key + ' 档「' + s + '」--r-xl 签名非空（边界格固定卡没匹配 → 直接 FAIL）：'
      + (g ? JSON.stringify(rXlOf(s)) : '签名缺失'));
  }
  for (const s of list) {
    const g = of(s);
    const n = g && Number.isFinite(g.sampleCount) ? g.sampleCount : 0;
    const h = g && Number.isFinite(g.hiddenCount) ? g.hiddenCount : (g ? 0 : 1);
    add(n >= 1, key + ' 档「' + s + '」有真实可见卡样本 ' + n + ' 张（selector 缺样本不得假通过）');
    add(h === 0, key + ' 档「' + s + '」无 hidden/零尺寸卡被静默遗漏（hiddenCount=' + h + '）');
  }
  for (const s of list) {
    const r = of(s) ? of(s).radius : undefined;
    add(Number.isFinite(r),
      key + ' 档「' + s + '」代表卡有真实 computed radius='
      + (Number.isFinite(r) ? r : JSON.stringify(r)) + '（非仅 :root 变量）');
  }
  const rxls = list.map(rXlOf);
  const combos = list.map(comboOf);
  add(allPresent && new Set(rxls).size === list.length,
    key + ' --r-xl 签名 set size=' + new Set(rxls).size + ' 须 = ' + list.length
    + '（soft/flat/notion 三档全不同；旧 >=2 会放行任意两档相同）：[' + rxls.join(',') + ']');
  add(allPresent && new Set(combos).size === list.length,
    key + ' 组合签名 (--r-xl|--border-w) set size=' + new Set(combos).size + ' 须 = '
    + list.length + '（可能组合 border width）：[' + combos.join(' , ') + ']');
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const sameR = rxls[i] === rxls[j], sameC = combos[i] === combos[j];
      add(!sameR && !sameC,
        key + ' 签名成对互异：' + list[i] + ' vs ' + list[j] + '（--r-xl '
        + (sameR ? '相同=' + rxls[i] : '不同') + '，组合签名 '
        + (sameC ? '相同=' + combos[i] : '不同') + '）');
    }
  }
  const flat = of('flat');
  const flatNum = parseFloat(rXlOf('flat'));
  add(!!flat && Number.isFinite(flatNum) && flatNum === 0
      && Number.isFinite(flat.radius) && flat.radius === 0,
    key + ' flat 档 --r-xl=0 且代表卡 computed radius=0（实际 rXl='
    + (flat ? rXlOf('flat') : '缺') + '，radius=' + (flat ? flat.radius : '缺') + '）');
  for (const s of list) {
    if (s === 'flat') continue;
    const r = of(s) ? of(s).radius : undefined;
    add(Number.isFinite(r) && r > 0,
      key + ' 非 flat 档「' + s + '」代表卡 computed radius>0（圆角真落在卡上）：' + r);
  }
  return { verdict: checks.every((c) => c.pass) ? 'ok' : 'violation', checks };
}

export async function run(ctx) {
  const { page, errors } = ctx;
  const helpers = ctx.helpers || {};
  const { evalJs, waitFor, sleep, num, WEB_PORT, TOUCH_DRAG_DELAY } = helpers;
  const ok = ctx.ok;
  const state = ctx.state;
  const { RADIUS_K, RADIUS_MIN, TOL_RATIO, TOL_PAD, CHECK_K, CHECK_MIN, CHECK_MAX, WEEK_HEAD, DUR, table, detail, VIEWPORTS, VIEWS } = state;
  console.log('\n二、断言：打勾左侧间距、圆角公式');
  for (const [key, m] of Object.entries(table)) {
    const cards = ['timed', 'untimed', 'pill'].map((k) => m[k]).filter(Boolean);
    if (!cards.length) continue;

    for (const c of cards) {
      const short = Math.min(c.h, c.w);
      /* 公式：min(--r-xl, max(下限, 短边 × K)) —— 上限走风格档，flat 档全是 0 */
      const want = Math.min(c.rXl, Math.max(RADIUS_MIN, short * RADIUS_K));
      ok(Math.abs(c.radius - want) <= 0.6,
        key + ' ' + c.cls.split(' ')[0] + ' 圆角 ' + num(c.radius)
        + ' = 短边 ' + num(short) + ' × ' + RADIUS_K + ' 夹在 ' + RADIUS_MIN + '~' + c.rXl
        + '（want ' + want.toFixed(2) + '）');
    }
    /* 月胶囊不许溢出格子，而且标题要真剩得下字（窄屏 5 个汉字是硬约束） */
    for (const c of cards.filter((k) => k.cellW != null)) {
      ok(c.w <= c.cellW + 0.5, key + ' 胶囊 ' + num(c.w) + ' 不溢出格子 ' + num(c.cellW));
      /* narrow 是这一屏的属性（在 m 上），不在单张卡上 —— 写成 c.narrow 会恒 undefined，
         于是窄屏也被拿桌面的 60 去量，红得指错地方 */
      const minTitle = m.narrow ? 40 : 60;
      ok(c.titleW >= minTitle, key + ' 标题可用宽 ' + num(c.titleW) + ' ≥ ' + minTitle
        + (m.narrow ? '（窄屏要装得下 5 个汉字）' : ''));
    }
    /* 打勾左侧间距：同一屏上所有卡一致（窄屏月 pill 没有勾选圈 → 不参与） */
    const gaps = cards.filter((c) => c.checkGap != null);
    if (gaps.length >= 2) {
      const base = gaps[0].checkGap;
      for (const c of gaps.slice(1)) {
        ok(Math.abs(c.checkGap - base) <= TOL_PAD,
          key + ' 勾选圈左侧间距一致：' + num(base) + ' vs ' + num(c.checkGap)
          + '（' + c.cls.split(' ')[0] + '）');
      }
    }
  }

  /* ── 圆角契约矩阵断言（00 采集；Reviewer 第 1/2 轮返工）────────────────────
     第 1 轮：弃用「applicableN>=1 && flatN>=1」总计数守卫（1 soft + 1 flat 就绿，
     缺格 / 误判不适用全被放过），改逐组合枚举。
     第 2 轮（本轮）：00 改为每格留 samples[]（逐张真实可见卡的完整读数），
     这里逐格调用纯函数 evaluateCell，对 samples **逐张**做短边契约断言 ——
     radius 用每张卡自己的 宽/高/--r-xl/k 重算 want 比对，flat 档逐张恒 0，
     逐张验 k、want 自洽、短边即高度；sampleCount 必须与 samples 长度相等，
     缺任一张都判违规。纯函数可脱离浏览器单测，负向路径见本轮临时验证日志。 */
  const spec = state.matrixSpec;
  const cap = state.viewCapability || {};
  const mx = state.radiusMatrix || [];
  const idx = new Map(mx.map((r) => [r.vp + '/' + r.view + '/' + r.style + '/' + r.kind, r]));
  const cover = { applicable: 0, unsupported: 0, formula: 0, flat: 0,
    missing: 0, violation: 0, cards: 0 };
  for (const vp of spec.VIEWPORTS) {
    const uiViews = (cap[vp] && cap[vp].uiViews) || [];
    for (const view of spec.MATRIX_VIEWS) {
      const uiProvides = uiViews.includes(view);
      for (const style of spec.STYLES) {
        for (const kind of spec.KINDS) {
          const key = vp + '/' + view + '/' + style + '/' + kind;
          const res = evaluateCell({
            key, view, style, uiProvides,
            viewProvidesKind: spec.VIEW_KINDS[view].includes(kind),
            cell: idx.get(key),
            unsupportedReason: spec.UNSUPPORTED_REASON[view + '/' + kind],
            RADIUS_K, RADIUS_MIN, num,
          });
          for (const l of res.logs) console.log('  ' + l);
          for (const c of res.checks) ok(c.pass, c.what);
          for (const k of Object.keys(cover)) cover[k] += res.cover[k];
        }
      }
    }
  }
  const totalCells = spec.VIEWPORTS.length * spec.MATRIX_VIEWS.length * spec.STYLES.length * spec.KINDS.length;
  /* 矩阵完整性：每视口 4 视图 × 3 风格 × 3 卡型 = 36 格，两视口共 72 格。
     00 采集的 radiusMatrix 每条记录都要在；漏格由 evaluateCell 判 missing 并 FAIL，
     这里再对「采集条数 = 应采格数」整体钉一次，防止整行缺采却无人发现。 */
  ok(mx.length === totalCells,
    '矩阵格完整：采集 ' + mx.length + ' 格 = 应采 ' + totalCells + ' 格（每视口 '
    + (totalCells / spec.VIEWPORTS.length) + ' 格 × ' + spec.VIEWPORTS.length
    + ' 视口，逐格已由 evaluateCell 断言）');
  console.log('    逐组合覆盖：适用 ' + cover.applicable + ' 格、不适用 ' + cover.unsupported
    + ' 格、漏格 ' + cover.missing + '、违规 ' + cover.violation
    + '（共 ' + totalCells + ' 格，逐格已断言，不以总计数当守卫）');
  const applicableCells = mx.filter((r) => r.applicable);
  const perCellCounts = applicableCells.map((r) => r.sampleCount);
  const sumCards = perCellCounts.reduce((a, b) => a + b, 0);
  console.log('    可审计卡数：适用格 ' + applicableCells.length + ' 格，逐格真实可见卡合计 '
    + sumCards + ' 张次（单格最少 ' + (perCellCounts.length ? Math.min(...perCellCounts) : 0)
    + ' / 最多 ' + (perCellCounts.length ? Math.max(...perCellCounts) : 0)
    + '）；逐张断言累计 ' + cover.cards + ' 张（公式 ' + cover.formula
    + ' / flat ' + cover.flat + ' 卡次），每张验 短边契约 + k + want 自洽 + 短边即高度');
  ok(sumCards === cover.cards,
    '可审计卡数自洽：适用格样本合计 ' + sumCards + ' = 逐张断言 ' + cover.cards + ' 张');

  /* ── viewport 覆盖报告（findings C + 本轮 viewport 缺失验证）──────────────
     EXPECT_VIEWPORTS 原本由 state.VIEWPORTS / 00 局部 VIEWPORTS 派生，与「实际
     成功配置的 viewport」同源，配置错一档会自证通过。本轮加**本地常量**
     EXPECTED_VP_NAMES（编排 card-geometry.mjs:45-48 固定的两档），作为不被
     state/spec 污染的独立真相源；evaluateViewportCoverage 纯函数逐项精确核验
     state.VIEWPORTS / spec.EXPECT_VIEWPORTS / spec.VIEWPORTS / 实际成功配置，
     任一来源缺一档或缩小期望都判 FAIL（负注入脚本 import 同一纯函数验证删档）。 */
  const expectVps = spec.EXPECT_VIEWPORTS || [];
  const vpCfg = state.viewportConfig || {};
  const configuredNames = Object.keys(vpCfg);
  console.log('    本地常量期望 viewport（card-geometry.mjs:45-48 固定，不与 state 同源）：'
    + EXPECTED_VP_NAMES.join('、'));
  console.log('    spec.EXPECT_VIEWPORTS（原同源派生）：'
    + expectVps.map((v) => v.name + '(' + v.w + '×' + v.h + ')').join('、')
    + '，共 ' + expectVps.length + ' 个');
  console.log('    实际成功配置的 viewport 个数：' + configuredNames.length + '，逐项：'
    + (configuredNames.length ? configuredNames.map((n) => n
      + '[metrics=' + !!vpCfg[n].metricsConfigured
      + ', views=' + vpCfg[n].viewsCompleted.length
      + ', cells=' + vpCfg[n].matrixCells + ']').join('；') : '（无）'));
  const matrixCellsByVp = {};
  for (const name of EXPECTED_VP_NAMES) matrixCellsByVp[name] = mx.filter((r) => r.vp === name).length;
  const vpEval = evaluateViewportCoverage({
    stateViewports: VIEWPORTS,
    specExpectViewports: spec.EXPECT_VIEWPORTS,
    specViewports: spec.VIEWPORTS,
    configuredNames, viewportConfig: vpCfg,
    matrixViewsLen: spec.MATRIX_VIEWS.length, stylesLen: spec.STYLES.length,
    kindsLen: spec.KINDS.length, matrixCellsByVp,
  });
  for (const e of vpEval.errors) console.error('  [viewport 配置错误] ' + e);
  for (const l of vpEval.logs) console.log('  ' + l);
  for (const c of vpEval.checks) ok(c.pass, c.what);

  /* ── 生产公式核对（用户要求）：生产 calendar.css:319 用 --card-h（高度）作圆角输入，
     界面规则第 4 条用短边 min(w,h)。两者等价的前提是「所有真实卡都是横向宽卡 w>h」。
     这里用 00 的**全量真实卡逐张读数**实证（Reviewer 第 2 轮：已改为逐张采
     radius/宽高/--r-xl/--card-h/k，不再只采 w/h；不掺任何 createElement 人造探针）：
       · w ≥ h 恒成立 → 短边恒 = 高度，生产 --card-h ≡ 短边契约，保留生产不改；
         几何保证（不是抽样巧合）：三种卡型的 --card-h 在 calendar.css 都定义为「卡片
         自身高度」（定时 --card-px = 时长像素高 − 缝，由 TaskCard.tsx:520,572 写；
         未定时 --row、月胶囊 --pill-h 都是一行高），而宽度是列宽/格子宽这类「整天 /
         整列 / 整格」的横向尺度；高度只用一行(16~30px)或一段时长(≤ 实测 53px)，
         横向尺度恒 ≥ 52px（窄屏月格实测 52.56、窄屏周列 78、日视图 317），
         布局结构上必为横向宽卡。本节再用全量真实卡确认无反例。
       · 若出现 w < h 竖卡 → 生产输入与短边分叉，按契约修生产公式（本轮基线未出现）。 */
  const shapes = state.cardShapes || [];
  const tall = shapes.filter((s) => s.w < s.h);
  const minMargin = shapes.length ? +Math.min(...shapes.map((s) => s.w - s.h)).toFixed(2) : null;
  console.log('    生产形态实证：全量真实卡 ' + shapes.length + ' 张（逐张采 radius/宽高/--r-xl/--card-h/k，'
    + '全部来自真实 DOM，非人造探针）；w<h 竖卡 ' + tall.length + ' 张；最小 w−h 余量 ' + num(minMargin) + 'px');
  ok(shapes.length > 0, '补采样到真实卡样本（不是空判）：' + shapes.length + ' 张');
  ok(tall.length === 0,
    '全量真实卡均为横向宽卡（w ≥ h，短边即高度）：竖卡 ' + tall.length + ' 张'
    + (tall.length ? '，例：' + JSON.stringify(tall.slice(0, 3)) : ''));

  /* 尺寸边界：按生产 DOM 结构造**专用探针元素**，输入只给 --card-h（与真实卡
     同一个入口、不另造圆角参数），卡住「撞 --r-xl 上限」与「2px 下限」两个
     切换点。真实六屏样本最高约 53px、最低 16px，覆盖不到这两段。
     ⚠️ 这两个是显式 createElement 探针，只用于撞边界；**绝不混入矩阵 samples**
     （Reviewer 第 2 轮：矩阵样本只认真实可见卡，不得靠造卡掩盖缺样本差异）。 */
  /* ── 尺寸边界探针（findings B）：与 00 一致改为分次 CDP + RAF 采集 ──────
     旧版三档塞进同一 evalJs 回调、改 dataset.style 后立即读，既没证实 CSS 生效，
     末尾 d.dataset.style = prev 也没有 try/finally（异常时不恢复）。现改为：
       · 每档两次独立 CDP 调用：设 style + await 两帧 RAF，再造探针读数 + 采签名；
       · 断言三档签名互异、flat --r-xl=0 → 证实 CSS 实际生效，失败报错；
       · try/finally 恢复原 style（异常也恢复），回读不符记 FAIL。 */
  const bounds = {};
  const prevBoundsStyle = await evalJs(page, `return document.documentElement.dataset.style || '';`);
  let boundsRestoreOk = false;
  try {
    for (const style of STYLE_SIGNATURE_STYLES) {
      // 分次 CDP #1：设 style + 浏览器等两帧 RAF（让 CSS 真正重算）
      await evalJs(page, `
        const d = document.documentElement;
        d.dataset.style = ${JSON.stringify(style)};
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return d.dataset.style;
      `);
      // 分次 CDP #2：采签名（含本次读取实际生效的档名）+ 造专用探针元素读数
      const shot = await evalJs(page, `
        const d = document.documentElement;
        const cs = getComputedStyle(d);
        const signature = { style: d.dataset.style,
          rXl: cs.getPropertyValue('--r-xl').trim(),
          borderW: cs.getPropertyValue('--border-w').trim() };
        const mk = (h) => {
          const el = document.createElement('div');
          el.className = 'task-el task-el--timed';
          /* 显式给 > 高度的宽度，短边才 = 高度 = --card-h，探针才在真实卡型
             方向上撞 --r-xl 上限 / 2px 下限；造这两个探针只为撞切换点，
             **不拿它们推断生产形状**（几何保证见本节上方「生产形态实证」）。 */
          el.style.setProperty('--card-h', h + 'px');
          el.style.height = h + 'px';
          el.style.width = (h + 60) + 'px';
          document.body.appendChild(el);
          const ecs = getComputedStyle(el);
          const r = parseFloat(ecs.borderTopLeftRadius) || 0;
          const cap = parseFloat(ecs.getPropertyValue('--r-xl')) || 0;
          const w = el.getBoundingClientRect().width;
          el.remove();
          return { h, w: +w.toFixed(2), radius: +r.toFixed(2), rXl: cap };
        };
        return { signature, cards: [mk(80), mk(4)] };
      `);
      bounds[style] = shot;
    }
    /* round6：三档签名成对互异判定。旧版只看 new Set(rxls).size>=2 &&
       new Set(bwds).size>=2，soft/notion 的 --border-w 都是 1px、任意两档
       --r-xl 相同都会放行（证明不了三档都生效）。现改为调用纯函数
       evaluateStyleSignatures：--r-xl set=3 + 组合签名含 --border-w 三档互异 +
       pairwise 逐对 + 每档独立 CDP 读取(dataset.style) + 每档代表卡真实
       computed radius + sampleCount/hiddenCount + flat 归零，任一不满足直接 FAIL。 */
    const boundSignatures = {};
    for (const style of STYLE_SIGNATURE_STYLES) {
      const shot = bounds[style];
      const rep = shot.cards.find((c) => Number.isFinite(c.radius)) || shot.cards[0];
      boundSignatures[style] = {
        style: shot.signature.style,
        rXl: shot.signature.rXl,
        borderW: shot.signature.borderW,
        radius: rep ? rep.radius : undefined,
        sampleCount: shot.cards.length,
        hiddenCount: 0,
      };
    }
    const boundEval = evaluateStyleSignatures({
      key: '02 边界探针', styles: STYLE_SIGNATURE_STYLES, signatures: boundSignatures });
    for (const c of boundEval.checks) ok(c.pass, c.what);
    const rxls = STYLE_SIGNATURE_STYLES.map((s) => bounds[s].signature.rXl);
    const bwds = STYLE_SIGNATURE_STYLES.map((s) => bounds[s].signature.borderW);
    console.log('    02 边界探针三档签名：--r-xl=[' + rxls.join(',') + '] --border-w=['
      + bwds.join(',') + ']；代表卡 computed radius=['
      + STYLE_SIGNATURE_STYLES.map((s) => boundSignatures[s].radius).join(',') + ']');
    if (boundEval.verdict !== 'ok') {
      throw new Error('02 边界探针风格切换 CSS 未生效（三档签名未成对互异 / flat 未归零）：'
        + '--r-xl=[' + rxls.join(',') + '] --border-w=[' + bwds.join(',') + ']');
    }
  } finally {
    // findings B：异常时也 finally 恢复原 style
    try {
      const restored = await evalJs(page, `
        document.documentElement.dataset.style = ${JSON.stringify(prevBoundsStyle)};
        return document.documentElement.dataset.style;
      `);
      boundsRestoreOk = (restored === prevBoundsStyle);
      if (!boundsRestoreOk) console.error('  [02 边界探针] 风格恢复回读不符');
    } catch (e) { console.error('  [02 边界探针] 风格恢复异常：' + (e && e.message ? e.message : e)); }
    ok(boundsRestoreOk, '02 边界探针 try/finally 恢复原 style=' + JSON.stringify(prevBoundsStyle));
  }
  for (const style of STYLE_SIGNATURE_STYLES) {
    for (const b of bounds[style].cards) {
      const short = Math.min(b.h, b.w);
      const want = Math.min(b.rXl, Math.max(RADIUS_MIN, short * RADIUS_K));
      ok(Math.abs(b.radius - want) <= 0.6,
        style + ' 边界探针 高 ' + num(b.h) + 'px：圆角 ' + num(b.radius)
        + ' = min(' + num(b.rXl) + ', max(' + RADIUS_MIN + ', 短边 ' + num(short)
        + ' × ' + RADIUS_K + ')) = ' + num(want));
    }
  }

  /* ── 所有适用 viewport/真实卡型：三档风格签名成对互异（round6 定点返工）──────
     02 边界探针只在当前页面用 createElement 探针量三档，覆盖不到「每个视口 ×
     每个视图 × 每种真实卡型」。这里用 00 分次 CDP 采到的 radiusMatrix（每格按
     style 分开、samples[] 是逐张真实可见卡的 computed radius/--r-xl/宽高），
     对每个**预期适用**组合（spec.VIEW_KINDS[view] 含该 kind）取 soft/flat/notion
     三格，调同一个纯函数 evaluateStyleSignatures 判定签名成对互异：
       · --r-xl 签名 set size=3（findings：旧 >=2 会放行任意两档相同）；
       · 组合签名 (--r-xl|--border-w) 三档互异 —— border-w 取本节边界探针段
         分次 CDP 独立读到的三档值（:root 全局档位变量，tokens.css 与
         vp/view/kind 无关，故对每个组合都成立）；
       · 每档代表卡有真实 computed radius、≥1 张真实可见卡样本、无 hidden/
         零尺寸卡被静默遗漏（selector 缺样本不得假通过）；
       · flat 档 --r-xl=0 且代表卡 radius=0；
       · 边界格固定卡没匹配（缺格 / applicable=false / violation / samples 空）
         → sampleCount=0 → 纯函数直接判 FAIL，绝不跳过。
     最后核验「签名选择器真实产生数据」：逐组合无跳过、覆盖不同 view 存在的卡型、
     每个组合三档都真的产生了签名数据点。 */
  const expectedKindPairs = [];
  for (const view of spec.MATRIX_VIEWS)
    for (const kind of spec.VIEW_KINDS[view]) expectedKindPairs.push(view + '/' + kind);
  const expectedCombos = [];
  for (const vp of spec.VIEWPORTS)
    for (const view of spec.MATRIX_VIEWS)
      for (const kind of spec.VIEW_KINDS[view]) expectedCombos.push({ vp, view, kind });
  let checkedCombos = 0, sigDataPoints = 0, sigViolations = 0;
  const sigKindsSeen = new Set();
  for (const { vp, view, kind } of expectedCombos) {
    const signatures = {};
    for (const style of STYLE_SIGNATURE_STYLES) {
      const cell = idx.get(vp + '/' + view + '/' + style + '/' + kind);
      const samples = cell && Array.isArray(cell.samples) ? cell.samples : [];
      const rep = samples.find((s) => Number.isFinite(s.radius)) || samples[0];
      const usable = !!cell && cell.applicable === true && !cell.violation && samples.length >= 1;
      signatures[style] = usable
        ? { style: cell.style,
            rXl: rep && Number.isFinite(rep.rXl) ? String(rep.rXl) : '',
            borderW: bounds[style].signature.borderW,
            radius: rep && Number.isFinite(rep.radius) ? rep.radius : undefined,
            sampleCount: samples.length,
            hiddenCount: Number.isFinite(cell.hiddenExpectedCount) ? cell.hiddenExpectedCount : 0 }
        : { style: null, rXl: '', borderW: bounds[style].signature.borderW,
            radius: undefined, sampleCount: 0, hiddenCount: 1 };
      if (usable) sigDataPoints++;
    }
    sigKindsSeen.add(view + '/' + kind);
    const res = evaluateStyleSignatures({
      key: vp + '/' + view + '/' + kind + ' 真实卡签名',
      styles: STYLE_SIGNATURE_STYLES, signatures });
    for (const c of res.checks) ok(c.pass, c.what);
    checkedCombos++;
    if (res.verdict !== 'ok') sigViolations++;
  }
  ok(checkedCombos === expectedCombos.length,
    '风格签名矩阵逐组合核验：预期适用组合 ' + expectedCombos.length + '，实查 '
    + checkedCombos + '（无跳过；边界格固定卡没匹配已由逐档 sampleCount 直接判 FAIL）');
  ok(sigKindsSeen.size === expectedKindPairs.length,
    '风格签名选择器真实产生数据：覆盖不同 view 存在的卡型 ' + sigKindsSeen.size + '/'
    + expectedKindPairs.length + '（[' + [...sigKindsSeen].join(',') + ']）');
  ok(sigDataPoints === checkedCombos * STYLE_SIGNATURE_STYLES.length,
    '风格签名真实数据点 ' + sigDataPoints + ' = ' + checkedCombos + ' 组合 × '
    + STYLE_SIGNATURE_STYLES.length + ' 档（每档须有真实可见卡样本）');
  ok(sigViolations === 0,
    '所有适用 viewport/真实卡型三档签名成对互异（违例组合 ' + sigViolations + ' 个）');
  console.log('    风格签名矩阵：' + checkedCombos + ' 个适用组合 × 3 档，'
    + sigDataPoints + ' 份真实卡签名数据，覆盖卡型 [' + [...sigKindsSeen].join(',')
    + ']；违例组合 ' + sigViolations + ' 个');

}
