/**
 * ui.ts —— UI 偏好
 */

import type { UiPrefs, AccentKey, StyleKey, ThemeMode } from '../types/types.ts';
import * as D from '../date.ts';
import { MIN_SPAN } from '../layout.ts';

// 加页面时这里必须一起加：normalizeUi 会把不在表里的 nav 兜回 'today'
// （旧版的 nav === 'notes' 就是这么处理的），漏了的话「刷新一下跳到别的页」。
// 另外 navOrder 也是照着这张表补全的，老用户本地存的那份顺序里没有新页 ——
// 补在这里，他们不用清 localStorage 就能看见它。
const NAV_ALL = [
  'inbox', 'today', 'overdue', 'calendar', 'projects', 'habits', 'done', 'ai', 'trash', 'settings',
];

/**
 * 可自定义的功能项 —— `navOrder` 与 `ui.tabs` 都只从这里面选。
 *
 * **设置不在里面，这是有意的**：它的入口固定在侧栏底部与「更多」抽屉里。
 * 放进来就等于允许用户把它自己隐藏掉，而「设置」正是他唯一能去改回来的地方 ——
 * 藏起来之后没有第二条路，界面上就是一个死角。
 */
export const CUSTOMIZABLE: readonly string[] = NAV_ALL.filter((k) => k !== 'settings');

/** 底栏最多放几项。「更多」恒占最后一格，所以总格数 ≤ 5（HIG 的 2–5 项） */
export const TAB_MAX = 4;

/**
 * 底栏兜底。**空栏等于没有导航**，所以过滤后不足 1 项就回落到这里。
 *
 * 顺序与 navOrder 的前 4 项一致 —— 底栏是 navOrder 的子集（见 normalizeUi），
 * 兜底值要是另排一套，用户会看到「恢复默认之后底栏顺序变了」。
 */
const DEFAULT_TABS: readonly string[] = ['inbox', 'today', 'overdue', 'calendar'];

/**
 * 底栏成员 = `ui.tabs` 按 `navOrder` 重排、只留认得的键、截到 `TAB_MAX`。
 *
 * **这个派生关系只有一个出口。** `ui.tabs` 里存的是「勾了哪几个」，顺序一律
 * 由 `navOrder` 说了算（侧栏拖个序，底栏跟着变 —— 两个列表没必要让用户各记一套）。
 *
 * 为什么必须是函数、不能只在 `normalizeUi` 里写一遍：`normalizeUi` **只在载入 /
 * 导入时跑**，而 `store.setUi()` 是个裸的浅合并（不归一）。于是「拖完侧栏，
 * 底栏顺序没变，刷新一下才对」—— 见踩坑 49。凡是会动 `navOrder` 或 `tabs` 的
 * 地方（`normalizeUi`、设置页的拖拽与勾选）都必须从这里过一遍。
 *
 * 兜底：过滤后一项都不剩 → 回落到 `DEFAULT_TABS`。**空栏没有合法解释**
 * （底栏空着等于没有导航），所以这里不区分 `[]` 与「没设置过」，与 `navBottom`
 * 那条「空数组是用户有意为之」正好相反。
 */
export function orderTabs(order: readonly string[], tabs: readonly string[]): string[] {
  const keep = new Set(
    Array.isArray(tabs) ? tabs.filter((k) => CUSTOMIZABLE.includes(k)) : [],
  );
  const list = order.filter((k) => keep.has(k)).slice(0, TAB_MAX);
  return list.length ? list : DEFAULT_TABS.slice();
}

/* 外观轴的白名单。**故意与 ui/theme.ts 的 ACCENTS / STYLES 重复** ——
   domain/ 不许引 ui/（那一层碰 DOM），而这两个列表的职责不同：
   那边是「渲染哪些选项」（Record<Key, …>，少一个键编译不过），
   这边是「磁盘上这个值还认不认」。加了新键要两边都补。 */
const ACCENT_ALL: readonly AccentKey[] = ['jade', 'azure', 'clay', 'plum', 'gold', 'slate'];
const STYLE_ALL: readonly StyleKey[] = ['soft', 'flat', 'notion'];
const THEME_ALL: readonly ThemeMode[] = ['auto', 'light', 'dark'];

export function defaultUi(): UiPrefs {
  return {
    nav: 'today',
    view: 'day',
    cursor: D.today(),
    theme: 'light',
    accent: 'jade',
    style: 'soft',
    search: '',
    navOrder: CUSTOMIZABLE.slice(),
    navBottom: ['trash'],
    navHidden: [],
    // 还没选过 → 由 resolveDefaultCal() 兜到「第一个自己建的集」
    defaultCal: null,
    tabs: DEFAULT_TABS.slice(),
    tdoneOpen: false,
    sel: null,
    // 就地新建的草稿格。瞬时状态，同上
    draft: null,
    cal: null,
    // 侧栏「显示哪几个集」。空数组只有 normalizeUi 的坏值回落才会真的出现 ——
    // store.toggleCal() 保证至少留一个勾着的（见 types.ts 的注释）
    cals: [],
    dayFrom: 0,
    dayTo: 24,
  };
}

/**
 * 改 UI 偏好。**只认得写进去的键**，其余原样保留 —— 调用方写
 * `setUi({ defaultCal: id })` 不会把别的偏好冲掉。
 */
export function setDefaultCal(ui: UiPrefs, calId: string | null): void {
  ui.defaultCal = calId && calId.trim() ? calId : null;
}

export function normalizeUi(raw: Partial<UiPrefs> | undefined): UiPrefs {
  const d = defaultUi();
  const ui: UiPrefs = { ...d, ...(raw || {}) };

  // 三档都要认。写成 `!== 'dark' ? 'light'` 会把用户选的「跟随系统」每次刷新打回
  // 常亮 —— 而 auto 是合法值，不是「没选」。
  if (!THEME_ALL.includes(ui.theme)) ui.theme = 'light';
  if (!ACCENT_ALL.includes(ui.accent)) ui.accent = 'jade';
  if (!STYLE_ALL.includes(ui.style)) ui.style = 'soft';
  // cal 只保证是字符串或 null。它到底还存不存在要等服务器把集列表发下来，
  // 那一步在 store.setCals 里做 —— normalizeUi 是纯函数，不知道有哪些集。
  if (ui.cal != null && typeof ui.cal !== 'string') ui.cal = null;
  // cals 是勾选显示的集合。老数据没有这个字段，落成 [] = 一个都不显示（老用户看到
  // 「日程页空了」），所以**从 cal 起步**：把当前那个集勾上。判的是 `raw.cals` 不是
  // `ui.cals` —— 上面已用默认值把 cals 补成 []，再问 ui.cals 永远是数组，老数据走不到。
  const rawCals = raw?.cals;
  if (!Array.isArray(rawCals)) ui.cals = ui.cal ? [ui.cal] : [];
  else ui.cals = rawCals.filter((x): x is string => typeof x === 'string');
  if (!['day', 'week', 'month'].includes(ui.view)) ui.view = 'day';
  /* 多选是**瞬时状态**，每次加载都清掉（2026-10-14）。
     不这么做的话，用户上次关页面时停在多选态，下次一打开 App 就莫名其妙
     处在多选里，而且还带着一堆可能已经过期的任务 id。 */
  ui.sel = null;
  /* 草稿格同样是**瞬时状态**（2026-10-15）：一个输入框赖在下一次会话的日程表
     上，用户第一眼看见的是「上次没打完的半句话」而不是今天要做的事；
     它记的日期多半也已经过期。 */
  ui.draft = null;
  normalizeDayWindow(ui);
  if (!ui.cursor) ui.cursor = D.today();
  if (ui.nav === 'notes') ui.nav = 'today';
  if (!NAV_ALL.includes(ui.nav)) ui.nav = 'today';
  ui.search = ui.search || '';
  // 旧版遗留的键直接丢掉。走 unknown 中转是必须的 —— UiPrefs 没有索引签名，
  // 直接 as Record<string, unknown> 会被严格模式拦下。
  const bag = ui as unknown as Record<string, unknown>;
  delete bag.notebookId;
  delete bag.noteId;
  delete bag.listFilter;

  normalizeNav(ui);

  // defaultCal 这里**只做形状校正**，不判断它还在不在列表里 —— `normalizeUi`
  // 拿不到 `cals`（签名只有 ui），那是 `resolveDefaultCal()` 的活。
  // 空串归一成 null：老版本没这个字段（undefined）与「显式留空」一样，
  // 都表示「没选过」，由 resolveDefaultCal 兜底。
  if (typeof ui.defaultCal !== 'string' || !ui.defaultCal) ui.defaultCal = null;

  // tabs 是 navOrder 的子集 —— 所以按 navOrder 的顺序重排它，而不是
  // 保留它在盘上自己的顺序。否则侧栏拖个序，底栏的顺序也跟着变，
  // 两个列表各排各的，用户不知道为什么。
  //
  // 口径在 `orderTabs()` 里，**设置页那两处写入方用的是同一个函数** ——
  // 在这里就地写一遍的话，那两处迟早和这里漂开（踩坑 49 就是这么来的）。
  ui.tabs = orderTabs(ui.navOrder, ui.tabs);

  return ui;
}

/** 时间窗归一化：只认 0–24 的整数小时，且至少留 MIN_SPAN 小时。
    写坏的值（字符串、NaN、to ≤ from）一律回落成整天 —— 归一化的职责是
    「认得的值原样保留，不认得的打回默认」，不是替用户猜一个好看的窗。 */
function normalizeDayWindow(ui: UiPrefs): void {
  const hour = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(24, Math.round(v))) : NaN;
  const from = hour(ui.dayFrom);
  const to = hour(ui.dayTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    ui.dayFrom = 0;
    ui.dayTo = 24;
  } else {
    ui.dayFrom = Math.min(from, 24 - MIN_SPAN / 60);
    ui.dayTo = Math.max(ui.dayFrom + MIN_SPAN / 60, to);
  }
}

/** 侧栏顺序归一化：navOrder 过滤+补全，navBottom / navHidden 按同一 order 过滤。
    三者的「空则默认 vs 空数组保留」口径各自不同，见各段注释。 */
function normalizeNav(ui: UiPrefs): void {
  // order 只收 CUSTOMIZABLE 里的键：设置不进这个列表（见上面的注释）。
  // 过滤 + 补全用的是同一个列表，两边不一致时会出现「过滤掉的又被补回来」。
  const order = Array.isArray(ui.navOrder)
    ? ui.navOrder.filter((k) => CUSTOMIZABLE.includes(k))
    : [];
  for (const k of CUSTOMIZABLE) if (order.indexOf(k) < 0) order.push(k);
  ui.navOrder = order;

  // navBottom 不能用「空则默认」的写法 —— 那会把用户主动拖出底部的垃圾箱又塞回去。
  // 必须区分「从未设置（undefined）→ 给默认」与「空数组 → 用户有意为之，原样保留」。
  const bottom = Array.isArray(ui.navBottom)
    ? ui.navBottom.filter((k) => order.indexOf(k) >= 0)
    : null;
  ui.navBottom = bottom === null ? ['trash'] : bottom;

  // navHidden = 宽屏侧栏里用户主动藏起来的项。**空数组就是合法状态**（一个都没藏），
  // 所以和 navBottom 一样要区分 undefined 与 []，不能写「空则给默认」。
  // 过滤口径和 navOrder 完全一致：只认 CUSTOMIZABLE 里的键，且必须真在 order 里
  //（藏一个压根不在顺序里的键没有意义，留着只会在别处被当成「有效项」）。
  ui.navHidden = Array.isArray(ui.navHidden)
    ? ui.navHidden.filter((k) => order.indexOf(k) >= 0)
    : [];
}

/* -------------------------------------------------------- 快速添加的默认值 */

/**
 * 快速添加的默认日期 / 时间 —— 由**当前所在 tab** 决定。
 *
 * 抽成纯函数是为了能被单测锁住：这张表是「界面偏好 → 新任务默认值」的映射，
 * 留在 Shell.tsx 里就只能靠浏览器探针测。
 *
 * `todayIso` 注入而不是内部取 `D.today()` —— 测试要能固定「今天」。
 */
export interface QuickDefaults {
  date: string | null;
  time: string | null;
}

/* 只读 `nav` 与 `cursor`，所以收 `Partial<UiPrefs>` —— 单测可以只摆这两样，
   不必为了测一张映射表去凑齐 theme / accent / tabs 那一串无关字段。 */
export function quickDefaults(ui: Partial<UiPrefs>, todayIso: string): QuickDefaults {
  // 待办箱：默认**无日期、无时间** —— 丢进去的就是「还没定哪天做」的事
  if (ui.nav === 'inbox') return { date: null, time: null };
  // 日程页：默认落在**当前看的那天**（cursor 是今天就是今天，否则 cursor）
  if (ui.nav === 'calendar') return { date: ui.cursor || todayIso, time: null };
  // 今天 / 逾期 / 打卡 / 已完成 / 项目：默认今天
  return { date: todayIso, time: null };
}
