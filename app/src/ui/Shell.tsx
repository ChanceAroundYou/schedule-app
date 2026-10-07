/**
 * Shell.tsx —— 侧栏 / 顶栏 / 底部标签栏 / 快速添加 / 找日期面板
 *
 * 三条必须守住的布局约定（都是踩坑换来的，改之前先读项目 CLAUDE.md）：
 *
 *   1. **顶栏绝对不能加 position / z-index / sticky。** 会生成层叠上下文，
 *      把里面的找日期面板（z-index 60）困住，被下方内容盖住变半透明。
 *      窄屏下顶栏随内容一起滚反而省垂直空间。
 *   2. **窄屏断点 900px** —— 这里的 `useIsNarrow()` 与 styles.css 的
 *      `@media (max-width: 900px)` 是同一根线，改一处必须改另一处。
 *   3. **浮层 z-index 必须 > 标签栏的 45**，否则抽屉被标签栏压住一截。
 *
 * 导航顺序读 `ui.navOrder`（全局顺序）+ `ui.navBottom`（哪些归底部组）。
 * `navBottom` 不能用「空则给默认值」的写法 —— 那会把用户主动拖出底部的
 * 垃圾箱又塞回去。必须区分 undefined（从未设置）与 []（有意为之）。
 *
 * ⚠️ 这两个字段**当前只读不写** —— 写入方（设置页里的排序）还没接上，
 *    见项目 CLAUDE.md 四、23。别以为「拖过一次就记住了」。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlarmClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CloudOff,
  Flame, FolderKanban, Inbox, Layers, Loader2, MailPlus,
  MoreHorizontal, Plus, Search, Settings, Sun, Trash2, X, Clock,
} from 'lucide-react';
import type { LocalState } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { counts, liveTasks, CUSTOMIZABLE, quickDefaults } from '../domain/model.ts';
import { parse, type ParseOut } from '../domain/parse.ts';
import { repeatLabel } from '../domain/repeat.ts';
import { useFocusTrap, useIsNarrow, useOutsideClose, useDebounced, useOnline } from './hooks.ts';
import { CalSwitcher } from './Calendars.tsx';
import { ClockPop } from './Clock.tsx';
import { MiniCalendar, DatePop } from './DatePop.tsx';

/* ============================== 导航表 ============================== */

export interface NavDef {
  key: string;
  label: string;
  icon: ReactNode;
  count?: 'inbox' | 'today' | 'overdue' | 'habits' | 'trash';
  warn?: boolean;
}

/** 图标一律 lucide，不用 emoji —— 语义精确、跨平台字形一致 */
export const NAV: NavDef[] = [
  { key: 'inbox', label: '待办箱', icon: <Inbox size={16} />, count: 'inbox' },
  { key: 'today', label: '今天', icon: <Sun size={16} />, count: 'today' },
  { key: 'overdue', label: '逾期', icon: <AlarmClock size={16} />, count: 'overdue', warn: true },
  { key: 'calendar', label: '日程', icon: <CalendarDays size={16} /> },
  { key: 'projects', label: '项目', icon: <FolderKanban size={16} /> },
  { key: 'habits', label: '打卡', icon: <Flame size={16} />, count: 'habits' },
  { key: 'done', label: '已完成', icon: <CheckCircle2 size={16} /> },
];

export const TRASH_NAV: NavDef = { key: 'trash', label: '垃圾箱', icon: <Trash2 size={16} />, count: 'trash' };

/**
 * 设置**不在** `ui.navOrder` 里（见 domain/model.ts 的 CUSTOMIZABLE）：
 * 它得能被打开，才谈得上改回来。所以它只进这张表，不参加排序。
 */
export const SETTINGS_NAV: NavDef = { key: 'settings', label: '设置', icon: <Settings size={16} /> };

const ALL_NAV = [...NAV, TRASH_NAV, SETTINGS_NAV];

/**
 * 按 nav key 取定义。**导出给设置页用** —— 那边的「功能区」卡片要画同一套
 * 图标与名字，在这儿另抄一份的下场是改了 label 忘了改那边。
 *
 * 认不出的 key 回落到垃圾箱：设置页只可能拿到 CUSTOMIZABLE 里的键，
 * 但拖拽时 dataTransfer 里塞的是用户数据，宁可画错也不要白屏。
 */
export const navDef = (k: string): NavDef => ALL_NAV.find((n) => n.key === k) || TRASH_NAV;

/** 没有 navOrder 时的兜底。取自 domain 的白名单，别在这里另抄一份 */
const DEFAULT_ORDER: readonly string[] = CUSTOMIZABLE;

/** `>99` 显示 `99+` —— 徽标再宽就挤垮布局了 */
function badge(n: number): string | null {
  if (!n) return null;
  return n > 99 ? '99+' : String(n);
}

/* ============================== 今日进度 ============================== */

/**
 * 侧栏底部那块「今日进度」，窄屏的「更多」抽屉里也放一份 —— 同一份数据同一套
 * 标记，两处不能各算各的（数字对不上时用户第一个发现）。
 *
 * 口径与其它徽标不同，**故意不同**：这里的分母是「今天排了的事」全部
 * （含已完成），分子是其中做完的。`counts().today` 是「今天还没做的」，
 * 拿它当分子会算出永远 0% 的进度条。
 */
export function Pulse({ state }: { state: LocalState }) {
  const t = D.today();
  const all = liveTasks(state).filter((x) => x.date === t);
  const undone = all.filter((x) => !x.done).length;
  const done = all.length - undone;
  const over = counts(state).overdue;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div className={'side-pulse' + (all.length && !undone ? ' all-done' : '')}>
      <div className="sp-head">
        <span className="sp-title">今日进度</span>
        <span className="sp-num"><b>{done}</b>/{all.length}</span>
      </div>
      <div className="sp-bar"><i style={{ width: pct + '%' }} /></div>
      <div className="sp-foot">
        {all.length ? (undone ? `还剩 ${undone} 件` : '今天清空了') : '今天还没有安排'}
        {!!over && <span className="sp-over">逾期 {over}</span>}
      </div>
    </div>
  );
}

/* =============================== 侧栏 =============================== */

function Sidebar({ state, onNav, onNew, onManageCal, onInvites }: {
  state: LocalState; onNav: (k: string) => void; onNew: () => void;
  onManageCal: () => void; onInvites: () => void;
}) {
  const c = counts(state);
  const order = state.ui.navOrder.length ? state.ui.navOrder : DEFAULT_ORDER;
  const bottom = state.ui.navBottom;

  // 主区 = 顺序里不属于底部组的；底部组 = 底部数组里的（按底部数组自己的顺序）
  const main = order.filter((k) => !bottom.includes(k));
  const bottoms = bottom.map(navDef);

  const item = (k: string) => {
    const def = navDef(k);
    const n = def.count ? (c as unknown as Record<string, number>)[def.count] : 0;
    const b = badge(n);
    return (
      <button
        className={'nav-item' + (state.ui.nav === k ? ' active' : '')}
        key={k}
        data-nav={k}
        /* 当前在哪一页：视觉上靠 .active 那点底色，读屏只认这个属性。
           侧栏和底部标签栏指同一件事（同一份 ui.nav），两处都写。 */
        aria-current={state.ui.nav === k ? 'page' : undefined}
        onClick={() => onNav(k)}
      >
        <span className="ico">{def.icon}</span>
        <span className="label">{def.label}</span>
        {b && <span className={'count' + (def.warn ? ' warn' : '')}>{b}</span>}
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">日</div>
        <div className="brand-name">日程清单</div>
      </div>

      <button className="quick-add" onClick={onNew}>
        <span className="plus"><Plus size={15} /></span>
        <span>新建任务</span>
      </button>

      {/* 日程集在导航之上：下面的日程 / 打卡 / 已完成是**按集**的，
          先选集再选页面，顺序跟用户脑子里的模型一致 */}
      <CalSwitcher state={state} onManage={onManageCal} onInvites={onInvites} />

      <nav className="nav" id="nav">{main.map(item)}</nav>
      <nav className="nav nav-bottom" id="navBottom">{bottoms.map((d) => item(d.key))}</nav>

      <Pulse state={state} />

      <div className="sidebar-footer">
        {/* 设置不参加排序，入口固定在这儿（和窄屏「更多」里那格是同一件事）。
            导入 / 导出 / 深浅 / 退出登录**只留在设置页一处** —— 这里原先各有一份
            重复入口，收进设置页之后侧栏底部只留设置这一个动作。 */}
        <button className="ghost-btn" data-nav="settings" onClick={() => onNav('settings')}>
          <Settings size={13} /> 设置
        </button>
        <div className="tip">数据已同步到服务器，本机也留了一份</div>
      </div>
    </aside>
  );
}

/* ============================== 找日期 ============================== */

/** 某天**还没做完**的任务数 —— 面板用它表示「哪天忙」 */
function jumpLoad(state: LocalState, isoDay: string): number {
  let n = 0;
  for (const k in state.tasks) {
    const t = state.tasks[k];
    if (t.date === isoDay && !t.deleted && !t.done) n++;
  }
  return n;
}

function JumpPop({ open, cursor, state, onPick, onClose }: {
  open: boolean; cursor: string; state: LocalState;
  onPick: (iso: string) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => D.monthStart(cursor));
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);

  useOutsideClose(box, open, onClose);
  useEffect(() => { if (open) { setMonth(D.monthStart(cursor)); setText(''); setBad(false); } }, [open, cursor]);

  if (!open) return null;

  const go = (v: string) => {
    // 基准用**面板所在月份**，不是今天 —— 见 domain/date.ts 的 parseDateText
    const d = D.parseDateText(v, month);
    if (d) { onPick(d); return; }
    setBad(true);
  };

  return (
    <div className="jump-pop" ref={box}>
      <div className="jp-row">
        <input
          type="text"
          value={text}
          placeholder="输入日期，如 10月15日"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(text); }}
        />
        <button className="jp-go" onClick={() => go(text)}>跳转</button>
      </div>

      {/* 月历格子与快速添加的「先选日期」共用同一份 —— 见 ui/DatePop.tsx */}
      <MiniCalendar
        month={month}
        value={cursor}
        todayIso={D.today()}
        loadOf={(iso) => jumpLoad(state, iso)}
        onMonth={setMonth}
        onPick={onPick}
      />

      {bad && <div className="jp-bad">没看懂这个日期，换个写法试试（例如「10月15日」「下周三」）</div>}
    </div>
  );
}

/* ============================== 顶栏 ============================== */

/** 搜索输入框的共享逻辑：本地状态 + 防抖回调 */
function useSearchValue(initial: string, onSearch: (kw: string) => void) {
  const [kw, setKw] = useState(initial);
  const debounced = useDebounced(kw, 180);
  useEffect(() => { onSearch(debounced); }, [debounced, onSearch]);
  return [kw, setKw] as const;
}

/** 搜索输入框（桌面常驻 / 移动浮条共用） */
function SearchInput({ kw, setKw, autoFocus }: {
  kw: string; setKw: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <div className="search-box">
      <span className="search-ico"><Search size={14} /></span>
      <input
        type="text"
        value={kw}
        placeholder="搜索…"
        aria-label="搜索任务"
        autoFocus={autoFocus}
        onChange={(e) => setKw(e.target.value)}
      />
      {!!kw && (
        <button className="clear-search" title="清空" onClick={() => setKw('')}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** 移动端搜索浮条：点击搜索图标后弹出 */
function SearchPop({ open, kw, setKw, onClose }: {
  open: boolean; kw: string; setKw: (v: string) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useOutsideClose(box, open, onClose);
  if (!open) return null;
  return (
    <div className="search-pop" ref={box}>
      <SearchInput kw={kw} setKw={setKw} autoFocus />
    </div>
  );
}

/**
 * 日程页副header：日期导航 + 视图切换 + 找日期
 *
 * 从Topbar抽出来，让顶栏只留标题 + 搜索 + 状态。
 * 日程页内容多，需要专门的副header来放这些控件。
 */
export function CalSubheader({ state, jump, setJump, onView, onShift, onToday, onCursor }: {
  state: LocalState;
  jump: boolean; setJump: (v: boolean) => void;
  onView: (v: LocalState['ui']['view']) => void;
  onShift: (n: number) => void;
  onToday: () => void;
  onCursor: (iso: string) => void;
}) {
  const ui = state.ui;
  const t0 = D.today();
  let atToday = ui.cursor === t0;
  if (ui.view === 'week') atToday = D.weekStart(ui.cursor) === D.weekStart(t0);
  else if (ui.view === 'month') {
    const a = D.parseISO(ui.cursor), b = D.parseISO(t0);
    atToday = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  // 日期长文本（原先在顶栏，随副header一起搬过来）。粒度跟着视图走：
  // 日 = 具体某天；周 = 这一周的起止；月 = 第几周（满屏六行时比「哪个月」有用）
  let range = D.fmtFull(ui.cursor);
  if (ui.view === 'week') {
    const s = D.weekStart(ui.cursor);
    range = D.fmtMD(s) + ' – ' + D.fmtMD(D.addDays(s, 6));
  } else if (ui.view === 'month') {
    range = '第 ' + D.weekOfMonth(ui.cursor) + ' 周';
  }

  return (
    <div className="cal-subhead">
      <div className="date-nav">
        <button className="round-btn" title="上一个" onClick={() => onShift(-1)}>
          <ChevronLeft size={15} />
        </button>
        <button className="round-btn" title="下一个" onClick={() => onShift(1)}>
          <ChevronRight size={15} />
        </button>
        <button
          className={'text-btn today-btn' + (atToday ? '' : ' away')}
          title={atToday ? '当前就在今天' : '跳回今天'}
          onClick={onToday}
        >{atToday ? '今天' : '回到今天'}</button>
        <span className="date-range">{range}</span>
        <div className="jump-wrap">
          <button
            className={'text-btn jump-btn' + (jump ? ' on' : '')}
            title="跳到指定日期（快捷键 D）"
            aria-haspopup="dialog"
            aria-expanded={jump}
            onClick={() => setJump(!jump)}
          >
            <span className="jb-ico"><CalendarDays size={13} /></span>
            <span className="jb-txt">找日期</span>
          </button>
          <JumpPop
            open={jump}
            cursor={ui.cursor}
            state={state}
            onPick={(d) => { onCursor(d); setJump(false); }}
            onClose={() => setJump(false)}
          />
        </div>
      </div>
      <div className="view-switch">
        <button data-view="day" className={ui.view === 'day' ? 'on' : ''} onClick={() => onView('day')}>日</button>
        <button data-view="week" className={ui.view === 'week' ? 'on' : ''} onClick={() => onView('week')}>周</button>
        <button data-view="month" className={ui.view === 'month' ? 'on' : ''} onClick={() => onView('month')}>月</button>
      </div>
    </div>
  );
}

export function Topbar({ state, narrow, searchOpen, setSearchOpen, onSearch }: {
  state: LocalState; narrow: boolean;
  searchOpen: boolean; setSearchOpen: (v: boolean) => void;
  onSearch: (kw: string) => void;
}) {
  const ui = state.ui;
  const online = useOnline();
  const [kw, setKw] = useSearchValue(ui.search, onSearch);

  // 标题写**具体日期 / 年月**，不写「日 / 周 / 月」。后者跟侧栏那一项重复，
  // 而用户在日程页真正想确认的就是「我现在看的是哪天」。
  // 日程页的日期长文本（日 = 某天 / 周 = 起止 / 月 = 第 N 周）在副header里，
  // 它就在下面一行 —— 顶栏别再写一遍，那是「两行都在报同一个日期」。
  let title = '今天';
  let range = D.fmtFull(D.today());
  if (ui.nav === 'inbox') { title = '待办箱'; range = '没有日期的事先放这儿'; }
  else if (ui.nav === 'overdue') { title = '逾期'; range = '没做完的，重新安排一下'; }
  else if (ui.nav === 'done') { title = '已完成'; range = ''; }
  else if (ui.nav === 'trash') { title = '垃圾箱'; range = ''; }
  else if (ui.nav === 'habits') { title = '打卡'; range = '坚持每天的小事'; }
  else if (ui.nav === 'settings') { title = '设置'; range = ''; }
  else if (ui.nav === 'calendar') {
    // 日期长文本归副header（就在下面一行）—— 顶栏只留标题，别把同一天写两遍
    title = ui.view === 'day'
      ? D.fmtMD(ui.cursor)
      : D.parseISO(ui.cursor).getFullYear() + '年' + (D.parseISO(ui.cursor).getMonth() + 1) + '月';
    range = '';
  }

  return (
    // 顶栏**不加** position / z-index / sticky，见文件头注释
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="view-title">{title}</h1>
        {!narrow && !!range && <span className="date-range">{range}</span>}
      </div>

      <div className="topbar-right">
        {narrow ? (
          <>
            <button
              className={'icon-btn search-toggle' + (searchOpen || kw ? ' on' : '')}
              title="搜索"
              aria-label="搜索任务"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(!searchOpen)}
            >
              <Search size={16} />
            </button>
            <SearchPop
              open={searchOpen}
              kw={kw}
              setKw={setKw}
              onClose={() => setSearchOpen(false)}
            />
          </>
        ) : (
          <SearchInput kw={kw} setKw={setKw} />
        )}

        {/* 深浅快捷按钮已收进设置页（外观卡）—— 顶栏只留状态，不留入口 */}

        {/* 离线优先于「正在同步」——断网时那个转圈会一直转下去，
            看起来像卡死了，而这句「改动不会丢」才是用户真正要的信息 */}
        {!online ? (
          <span className="sync-dot" title="离线，改动先存在本机，联网后自动同步">
            <CloudOff size={14} />
          </span>
        ) : !narrow && state.syncing ? (
          <span className="sync-dot" title="正在同步">
            <Loader2 size={14} className="animate-spin" />
          </span>
        ) : null}
      </div>
    </header>
  );
}

/* ============================ 底部标签栏 ============================ */

/**
 * 底栏成员读 `ui.tabs`，顺序也取自它（`normalizeUi` 保证它是 navOrder 的子集，
 * 所以侧栏拖个序，底栏跟着变 —— 两个列表的顺序没必要让用户各记一套）。
 *
 * 「更多」恒占最后一格，所以总格数 ≤ 5。
 */
export function Tabbar({ state, onNav, onMore }: {
  state: LocalState; onNav: (k: string) => void; onMore: () => void;
}) {
  const c = counts(state);
  const tabs = state.ui.tabs.map(navDef);
  return (
    <nav className="tabbar">
      {tabs.map((t) => {
        const b = badge(t.count ? (c as unknown as Record<string, number>)[t.count] : 0);
        return (
          <button
            className={'tab' + (state.ui.nav === t.key ? ' active' : '')}
            key={t.key}
            aria-current={state.ui.nav === t.key ? 'page' : undefined}
            onClick={() => onNav(t.key)}
          >
            <span className="ti">{t.icon}</span>
            <span className="tn">{t.label}</span>
            {b && <span className={'tb' + (t.warn ? ' warn' : '')}>{b}</span>}
          </button>
        );
      })}
      {/* 「更多」在打卡 / 已完成 / 垃圾箱这几页要点亮 —— 那几页只能从这里进，
          没高亮的话用户看不出自己当前在哪。判据是「当前 nav 不在 ui.tabs 里」，
          与底栏成员读的是同一份数据，不另立一套常量。 */}
      <button className={'tab' + (!state.ui.tabs.includes(state.ui.nav) ? ' active' : '')} onClick={onMore}>
        <span className="ti"><MoreHorizontal size={18} /></span>
        <span className="tn">更多</span>
      </button>
    </nav>
  );
}

/**
 * 「更多」抽屉：底栏没放进去的功能项 + 日程集 / 邀请 / 设置。
 *
 * 前半截是**差集**（`navOrder` 减去 `ui.tabs`），不是写死哪几项 ——
 * 底栏那 4 格是用户自己挑的，写死就会出现「底栏有、这里也有」的重复项。
 *
 * **深浅 / 导入 / 导出 / 退出登录不在这儿**：它们只有设置页一个入口
 * （外观卡、数据卡、账户卡）。抽屉里再放一份就是第二套入口，两边迟早说不到一起。
 */
export function MoreSheet({ state, open, onClose, onNav, onManageCal, onInvites }: {
  state: LocalState; open: boolean; onClose: () => void; onNav: (k: string) => void;
  onManageCal: () => void; onInvites: () => void;
}) {
  const c = counts(state);
  const panel = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useFocusTrap(panel, open);

  /* 同 Drawer：焦点送进面板本身（送进控件会弹软键盘），关掉还回去。
     这个浮层盖着一层遮罩，Tab 能溜到背后的侧栏上 —— 那正是 aria-modal
     答应读屏「外面别念」之后不能出现的事。 */
  useEffect(() => {
    if (!open) return;
    if (!panel.current?.contains(document.activeElement)) {
      prevFocus.current = document.activeElement as HTMLElement | null;
    }
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const goto = (k: string) => { onNav(k); onClose(); };
  // 窄屏侧栏收起来了，日程集入口得在这里有一份
  const cal = state.cals.find((x) => x.id === state.ui.cal) || null;
  const pending = state.invites.length;

  /**
   * 底栏没放进去的功能项，在这里补一份。
   *
   * 顺序跟着 navOrder 走 —— 与侧栏一致，用户扫一眼就知道在哪儿。
   * 差集而不是「写死哪几项」：底栏那 4 格是用户自己挑的，写死就会
   * 出现「底栏有、这里也有」的重复项。
   */
  const inTabs = new Set(state.ui.tabs);
  const order = state.ui.navOrder.length ? state.ui.navOrder : DEFAULT_ORDER;
  const rest = order.filter((k) => !inTabs.has(k)).map(navDef);

  const navTile = (def: NavDef) => {
    const n = def.count ? (c as unknown as Record<string, number>)[def.count] : 0;
    const b = badge(n);
    return (
      <button className="ms-item" key={def.key} data-nav={def.key} onClick={() => goto(def.key)}>
        <span className="mi">{def.icon}</span><span className="mt">{def.label}</span>
        {b && <span className="mc">{b}</span>}
      </button>
    );
  };

  return (
    <>
      <div className="sheet-mask" aria-hidden="true" onClick={onClose} />
      <div
        className="more-sheet"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="更多"
        tabIndex={-1}
      >
        <div className="ms-grab" />
        <div className="ms-grid">
          {rest.map(navTile)}
          <button className="ms-item" onClick={() => { onManageCal(); onClose(); }}>
            <span className="mi"><Layers size={20} /></span>
            <span className="mt">{cal ? cal.name : '日程集'}</span>
          </button>
          {!!pending && (
            <button className="ms-item" onClick={() => { onInvites(); onClose(); }}>
              <span className="mi"><MailPlus size={20} /></span><span className="mt">邀请</span>
              <span className="mc">{badge(pending)}</span>
            </button>
          )}
          <button className="ms-item" data-nav="settings" onClick={() => goto('settings')}>
            <span className="mi"><Settings size={20} /></span><span className="mt">设置</span>
          </button>
        </div>
        {/* 窄屏侧栏是收起的，进度搬进抽屉里，两处渲染的是同一个 Pulse */}
        <div className="ms-pulse"><Pulse state={state} /></div>
      </div>
    </>
  );
}

/* ============================== 快速添加 ============================== */

/** 占位符**不随 tab 变** —— 需求 1B：展开后文本不需要跟着所在的 tab 变。
    按 tab 写不同文案的代价是「切个 tab，输入框里的话就变了」，用户会以为
    自己刚才打的东西被吃了。 */
const QUICK_PLACEHOLDER = '新建任务，回车保存';

export function QuickAdd({ state, onSubmit }: {
  state: LocalState;
  onSubmit: (draft: { title: string; date: string | null; time: string | null; duration?: number; repeat?: unknown }, openDetail: boolean) => void;
}) {
  const narrow = useIsNarrow();
  const [text, setText] = useState('');
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [pendingTime, setPendingTime] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // 窄屏默认收起成右下角一个 FAB，点一下展开、再点收起（需求 3C）
  const [expanded, setExpanded] = useState(!narrow);
  const [dateOpen, setDateOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  // 「N」快捷键与 FAB 都要先展开再聚焦 —— 展开是异步的，得等 DOM 更新
  const focusOnExpand = useRef(false);
  const clockBtn = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ui = state.ui;
  const def = quickDefaults(ui, D.today());
  const parsed: ParseOut | null = text.trim() ? parse(text) : null;
  // 生效值：picker > 文本解析 > tab 默认。预览画的是生效值，不让人猜
  const effDate = pendingDate ?? parsed?.date ?? def.date;
  const effTime = pendingTime ?? parsed?.time ?? def.time;
  const chips: [string, string][] = [];
  if (effDate) chips.push(['date', D.relLabel(effDate)]);
  if (effTime) chips.push(['time', effTime]);
  if (parsed?.duration) chips.push(['dur', D.fmtDuration(parsed.duration)]);
  if (parsed?.repeat) chips.push(['rep', repeatLabel(parsed.repeat)]);

  const submit = (openDetail: boolean) => {
    const raw = text.trim();
    if (!raw) return;
    const p = parse(raw);
    const date = pendingDate ?? p?.date ?? def.date;
    const time = pendingTime ?? p?.time ?? def.time;
    setText('');
    setPendingDate(null);
    setPendingTime(null);
    onSubmit({
      title: (p?.title || raw),
      date,
      time,
      duration: p?.duration ?? undefined,
      repeat: p?.repeat ?? undefined,
    }, openDetail);
  };

  // 「N」聚焦输入框，跟旧版一致。窄屏下先展开再聚焦
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (narrow && !expanded) { setExpanded(true); focusOnExpand.current = true; }
        else inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [narrow, expanded]);

  // 展开之后才聚焦 —— 收起的横条是 display:none，聚焦不上去
  useEffect(() => {
    if (expanded && focusOnExpand.current) {
      focusOnExpand.current = false;
      inputRef.current?.focus();
    }
  }, [expanded]);

  const hasWhen = !!(pendingDate || pendingTime);

  return (
    <>
      {/* 设置页没有「往这儿加一条任务」这回事 —— 留着会让人以为加进设置里了 */}
      <div
        className="fast-add"
        hidden={ui.nav === 'trash' || ui.nav === 'settings' || (narrow && !expanded)}
      >
        <span className="fast-plus"><Plus size={15} /></span>
        <input
          ref={inputRef}
          type="text"
          value={text}
          placeholder={QUICK_PLACEHOLDER}
          aria-label="快速添加"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(e.ctrlKey || e.metaKey); }
            if (e.key === 'Escape') { e.currentTarget.blur(); }
          }}
        />
        <button
          ref={clockBtn}
          className={'fast-clock' + (hasWhen ? ' on' : '')}
          type="button"
          title="选择日期和时间"
          onClick={() => {
            // 两层：先选日期、再选时间。已经开着哪层就关哪层
            if (dateOpen) { setDateOpen(false); return; }
            if (clockOpen) { setClockOpen(false); return; }
            setDateOpen(true);
          }}
        >
          <Clock size={15} />
          {hasWhen && (
            <span className="fc-time">
              {pendingDate ? D.fmtMD(pendingDate) : ''}
              {pendingDate && pendingTime ? ' ' : ''}
              {pendingTime || ''}
            </span>
          )}
        </button>
        <DatePop
          open={dateOpen}
          anchor={clockBtn.current}
          value={pendingDate ?? def.date}
          todayIso={D.today()}
          loadOf={(iso) => jumpLoad(state, iso)}
          onPick={(d) => { setPendingDate(d); setDateOpen(false); setClockOpen(true); }}
          onClear={() => { setPendingDate(null); setDateOpen(false); setClockOpen(true); }}
          onClose={() => setDateOpen(false)}
        />
        <ClockPop
          open={clockOpen}
          anchor={clockBtn.current}
          value={pendingTime}
          onChange={(v) => { setPendingTime(v); setClockOpen(false); }}
          onClose={() => setClockOpen(false)}
        />
        {/* 选了日期 / 时间就把 hint 换成确认句 —— 一眼能看出「这一条会带上
            10月20日 15:00」，不然只有那个小胶囊显示，很容易漏看 */}
        <span className="fast-hint">
          {hasWhen
            ? [pendingDate && '日期 ' + D.fmtMD(pendingDate), pendingTime && '时间 ' + pendingTime]
                .filter(Boolean).join(' · ') + ' · 再点时钟图标可改'
            : 'Ctrl + Enter 打开详细设置'}
        </span>

        <div className={'fast-parse' + (chips.length && (focused || !!text) ? ' show' : '')}>
          {!!chips.length && (
            <>
              <span className="fp-chip k-title">{parsed?.title || text}</span>
              <span className="fp-arrow">→</span>
              {chips.map(([k, v]) => <span className={'fp-chip k-' + k} key={k}>{v}</span>)}
            </>
          )}
        </div>
      </div>

      {/* 窄屏的浮动 + 号：常驻右下角，点了展开横条、再点收起（变成 ×） */}
      {narrow && (
        <button
          className={'fast-fab' + (expanded ? ' open' : '')}
          type="button"
          hidden={ui.nav === 'trash' || ui.nav === 'settings'}
          title={expanded ? '收起快速添加' : '快速添加'}
          aria-label={expanded ? '收起快速添加' : '快速添加'}
          aria-expanded={expanded}
          onClick={() => {
            if (!expanded) focusOnExpand.current = true;
            setExpanded((v) => !v);
          }}
        >
          {expanded ? <X size={20} /> : <Plus size={20} />}
        </button>
      )}
    </>
  );
}

/* ============================== 外壳 ============================== */

export function Shell({
  state, contentRef, onNav, onNew,
  onManageCal, onInvites, more, setMore, topbar, quickAdd, children,
}: {
  state: LocalState;
  contentRef: React.RefObject<HTMLDivElement>;
  onNav: (k: string) => void;
  onNew: () => void;
  onManageCal: () => void;
  onInvites: () => void;
  /** 「更多」抽屉的开关放在 App 那边 —— Esc 要按 actSheet > 抽屉 > 找日期 的顺序关 */
  more: boolean; setMore: (v: boolean) => void;
  topbar: ReactNode;
  quickAdd: ReactNode;
  children: ReactNode;
}) {
  const narrow = useIsNarrow();

  // 抽屉开着时给 body 一个标记：窄屏下 `.tab:active` 要压住，别在抽屉后面乱闪。
  // 旧版就有这个约定，重构时漏了，连带那条 CSS 规则一起成了死代码
  useEffect(() => {
    document.body.classList.toggle('sheet-open', more);
    return () => document.body.classList.remove('sheet-open');
  }, [more]);

  return (
    <div className="app">
      {!narrow && (
        <Sidebar
          state={state} onNav={onNav} onNew={onNew}
          onManageCal={onManageCal} onInvites={onInvites}
        />
      )}

      <main className="main">
        {topbar}
        <div className="content" id="content" ref={contentRef}>{children}</div>
        {quickAdd}
      </main>

      {narrow && <Tabbar state={state} onNav={onNav} onMore={() => setMore(true)} />}
      <MoreSheet
        state={state} open={more && narrow} onClose={() => setMore(false)}
        onNav={onNav} onManageCal={onManageCal} onInvites={onInvites}
      />
    </div>
  );
}
