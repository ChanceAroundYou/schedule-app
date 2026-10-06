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
 * 侧栏顺序可拖动：`ui.navOrder`（全局顺序）+ `ui.navBottom`（哪些归底部组）。
 * `navBottom` 不能用「空则给默认值」的写法 —— 那会把用户主动拖出底部的
 * 垃圾箱又塞回去。必须区分 undefined（从未设置）与 []（有意为之）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlarmClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CloudOff,
  Flame, Inbox, Layers, Loader2, LogOut, MailPlus, Moon, MoreHorizontal, Plus,
  Search, Sparkles, Sun, Trash2, Upload, X, Download, Clock,
} from 'lucide-react';
import type { LocalState, PublicUser } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import { counts, liveTasks } from '../domain/model.ts';
import { parse, type ParseOut } from '../domain/parse.ts';
import { repeatLabel } from '../domain/repeat.ts';
import { useIsNarrow, useOutsideClose, useDebounced, useOnline } from './hooks.ts';
import { IconBtn } from './kit.tsx';
import { CalSwitcher } from './Calendars.tsx';

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
  { key: 'habits', label: '打卡', icon: <Flame size={16} />, count: 'habits' },
  { key: 'done', label: '已完成', icon: <CheckCircle2 size={16} /> },
  { key: 'ai', label: 'AI', icon: <Sparkles size={16} /> },
];

export const TRASH_NAV: NavDef = { key: 'trash', label: '垃圾箱', icon: <Trash2 size={16} />, count: 'trash' };
const ALL_NAV = [...NAV, TRASH_NAV];
const navDef = (k: string): NavDef => ALL_NAV.find((n) => n.key === k) || TRASH_NAV;

const DEFAULT_ORDER = ALL_NAV.map((n) => n.key);

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

function Sidebar({ state, onNav, onNew, onExport, onImport, onLogout, onManageCal, onInvites }: {
  state: LocalState; onNav: (k: string) => void; onNew: () => void;
  onExport: () => void; onImport: (f: File) => void; onLogout: () => void;
  onManageCal: () => void; onInvites: () => void;
}) {
  const c = counts(state);
  const order = state.ui.navOrder.length ? state.ui.navOrder : DEFAULT_ORDER;
  const bottom = state.ui.navBottom;
  const fileRef = useRef<HTMLInputElement>(null);

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
        <button className="ghost-btn" onClick={onExport}><Upload size={13} /> 导出备份</button>
        <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
          <Download size={13} /> 导入备份
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = '';
          }}
        />
        <button className="ghost-btn" onClick={onLogout}><LogOut size={13} /> 退出登录</button>
        <div className="tip">数据已同步到服务器，本机也留了一份</div>
      </div>
    </aside>
  );
}

/* ============================== 找日期 ============================== */

function JumpPop({ open, cursor, onPick, onClose }: {
  open: boolean; cursor: string; onPick: (iso: string) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => D.monthStart(cursor));
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);

  useOutsideClose(box, open, onClose);
  useEffect(() => { if (open) { setMonth(D.monthStart(cursor)); setText(''); setBad(false); } }, [open, cursor]);

  if (!open) return null;

  const days = D.monthMatrix(month);
  const curMonth = D.parseISO(month).getMonth();
  const today = D.today();

  const go = (v: string) => {
    const p = parse(v);
    if (p && p.date) { onPick(p.date); return; }
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

      <div className="jp-head">
        <button className="jp-nav" title="上个月" onClick={() => setMonth(D.addMonths(month, -1))}>
          <ChevronLeft size={14} />
        </button>
        <span className="jp-label">
          {D.parseISO(month).getFullYear()} 年 {D.parseISO(month).getMonth() + 1} 月
        </span>
        <button className="jp-nav" title="下个月" onClick={() => setMonth(D.addMonths(month, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="jp-week">
        <span>一</span><span>二</span><span>三</span><span>四</span>
        <span>五</span><span>六</span><span>日</span>
      </div>

      <div className="jp-grid">
        {days.map((d) => {
          const out = D.parseISO(d).getMonth() !== curMonth;
          return (
            <button
              // 日期密度用**淡底 + 底部短横**，不用 4px 圆点 ——
              // 圆点在 1x 屏上几乎看不见（实测截图确认过）
              className={'jp-day' + (out ? ' out' : '') + (d === today ? ' today' : '')
                + (d === cursor ? ' sel' : '')}
              key={d}
              data-jump={d}
              onClick={() => onPick(d)}
            >{D.parseISO(d).getDate()}</button>
          );
        })}
      </div>

      {bad && <div className="jp-bad">没看懂这个日期，换个写法试试（例如「10月15日」「下周三」）</div>}
    </div>
  );
}

/* ============================== 顶栏 ============================== */

export function Topbar({ state, narrow, onView, onShift, onToday, onCursor, onTheme, onSearch }: {
  state: LocalState; narrow: boolean;
  onView: (v: LocalState['ui']['view']) => void;
  onShift: (n: number) => void;
  onToday: () => void;
  onCursor: (iso: string) => void;
  onTheme: () => void;
  onSearch: (kw: string) => void;
}) {
  const ui = state.ui;
  const online = useOnline();
  const [jump, setJump] = useState(false);
  const [kw, setKw] = useState(ui.search);
  const debounced = useDebounced(kw, 180);

  useEffect(() => { onSearch(debounced); }, [debounced, onSearch]);

  let title = '今天';
  let range = D.fmtFull(D.today());
  if (ui.nav === 'inbox') { title = '待办箱'; range = '没有日期的事先放这儿'; }
  else if (ui.nav === 'overdue') { title = '逾期'; range = '没做完的，重新安排一下'; }
  else if (ui.nav === 'done') { title = '已完成'; range = ''; }
  else if (ui.nav === 'trash') { title = '垃圾箱'; range = ''; }
  else if (ui.nav === 'habits') { title = '打卡'; range = '坚持每天的小事'; }
  else if (ui.nav === 'ai') { title = 'AI'; range = '问它排期上的事'; }
  else if (ui.nav === 'calendar') {
    title = ui.view === 'day' ? '日' : ui.view === 'week' ? '周' : '月';
    if (ui.view === 'day') range = D.fmtFull(ui.cursor);
    else if (ui.view === 'week') range = D.fmtMD(D.weekStart(ui.cursor)) + ' – ' + D.fmtMD(D.addDays(D.weekStart(ui.cursor), 6));
    else range = D.parseISO(ui.cursor).getFullYear() + ' 年 ' + (D.parseISO(ui.cursor).getMonth() + 1) + ' 月';
  }

  const isCal = ui.nav === 'calendar' || ui.nav === 'today';

  return (
    // 顶栏**不加** position / z-index / sticky，见文件头注释
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="view-title">{title}</h1>
        <div className="date-nav">
          {isCal && (
            <>
              <button className="round-btn" title="上一个" onClick={() => onShift(-1)}>
                <ChevronLeft size={15} />
              </button>
              <button className="round-btn" title="下一个" onClick={() => onShift(1)}>
                <ChevronRight size={15} />
              </button>
              <button className="text-btn today-btn" title="回到今天" onClick={onToday}>今天</button>
            </>
          )}
          <span className="date-range">{range}</span>
          {ui.nav === 'calendar' && (
            <div className="jump-wrap">
              <button className="text-btn jump-btn" title="跳到指定日期（快捷键 D）" onClick={() => setJump((v) => !v)}>
                <span className="jb-ico"><CalendarDays size={13} /></span>
                <span className="jb-txt">找日期</span>
              </button>
              <JumpPop
                open={jump}
                cursor={ui.cursor}
                onPick={(d) => { onCursor(d); setJump(false); }}
                onClose={() => setJump(false)}
              />
            </div>
          )}
        </div>
      </div>

      <div className="topbar-right">
        <div className="search-box">
          <span className="search-ico"><Search size={14} /></span>
          <input
            type="text"
            value={kw}
            placeholder="搜索…"
            aria-label="搜索任务"
            onChange={(e) => setKw(e.target.value)}
          />
          {!!kw && (
            <button className="clear-search" title="清空" onClick={() => setKw('')}>
              <X size={13} />
            </button>
          )}
        </div>

        {ui.nav === 'calendar' && (
          <div className="view-switch">
            {/* data-view 是给探针用的：这三个按钮原先只能靠文字「日 / 周 / 月」去找，
                而文字是最不稳的定位方式。全应用其余可点元素都带 data-*，
                这里补上同一个约定。 */}
            <button data-view="day" className={ui.view === 'day' ? 'on' : ''} onClick={() => onView('day')}>日</button>
            <button data-view="week" className={ui.view === 'week' ? 'on' : ''} onClick={() => onView('week')}>周</button>
            <button data-view="month" className={ui.view === 'month' ? 'on' : ''} onClick={() => onView('month')}>月</button>
          </div>
        )}

        <IconBtn label="切换深浅色" onClick={onTheme}>
          {ui.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconBtn>

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

const TABS = [
  { key: 'today', label: '今天', icon: <Sun size={18} />, count: 'today' as const },
  { key: 'calendar', label: '日程', icon: <CalendarDays size={18} /> },
  { key: 'inbox', label: '待办', icon: <Inbox size={18} />, count: 'inbox' as const },
  // 逾期必须留在底栏 —— 用户重视的功能，不能藏进「更多」
  { key: 'overdue', label: '逾期', icon: <AlarmClock size={18} />, count: 'overdue' as const, warn: true },
];

export function Tabbar({ state, onNav, onMore }: {
  state: LocalState; onNav: (k: string) => void; onMore: () => void;
}) {
  const c = counts(state);
  return (
    <nav className="tabbar">
      {TABS.map((t) => {
        const b = badge(t.count ? (c as unknown as Record<string, number>)[t.count] : 0);
        return (
          <button className={'tab' + (state.ui.nav === t.key ? ' active' : '')} key={t.key} onClick={() => onNav(t.key)}>
            <span className="ti">{t.icon}</span>
            <span className="tn">{t.label}</span>
            {b && <span className={'tb' + (t.warn ? ' warn' : '')}>{b}</span>}
          </button>
        );
      })}
      <button className="tab" onClick={onMore}>
        <span className="ti"><MoreHorizontal size={18} /></span>
        <span className="tn">更多</span>
      </button>
    </nav>
  );
}

/** 「更多」抽屉：打卡 / 已完成 / 垃圾箱 / 主题 / 备份 / 退出 */
export function MoreSheet({ state, open, onClose, onNav, onTheme, onExport, onImport, onLogout,
  onManageCal, onInvites, user }: {
  state: LocalState; open: boolean; onClose: () => void; onNav: (k: string) => void;
  onTheme: () => void; onExport: () => void; onImport: (f: File) => void;
  onLogout: () => void; onManageCal: () => void; onInvites: () => void;
  user: PublicUser | null;
}) {
  const c = counts(state);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!open) return null;

  const goto = (k: string) => { onNav(k); onClose(); };
  // 窄屏侧栏收起来了，日程集入口得在这里有一份
  const cal = state.cals.find((x) => x.id === state.ui.cal) || null;
  const pending = state.invites.length;

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className="more-sheet">
        <div className="ms-grab" />
        <div className="ms-grid">
          <button className="ms-item" onClick={() => goto('habits')}>
            <span className="mi"><Flame size={20} /></span><span className="mt">打卡</span>
            {badge(c.habits) && <span className="mc">{badge(c.habits)}</span>}
          </button>
          <button className="ms-item" onClick={() => goto('done')}>
            <span className="mi"><CheckCircle2 size={20} /></span><span className="mt">已完成</span>
          </button>
          <button className="ms-item" onClick={() => goto('ai')}>
            <span className="mi"><Sparkles size={20} /></span><span className="mt">AI</span>
          </button>
          <button className="ms-item" onClick={() => goto('trash')}>
            <span className="mi"><Trash2 size={20} /></span><span className="mt">垃圾箱</span>
            {badge(c.trash) && <span className="mc">{badge(c.trash)}</span>}
          </button>
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
          <button className="ms-item" onClick={onTheme}>
            <span className="mi">{state.ui.theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}</span>
            <span className="mt">{state.ui.theme === 'dark' ? '浅色' : '深色'}</span>
          </button>
          <button className="ms-item" onClick={onExport}>
            <span className="mi"><Upload size={20} /></span><span className="mt">导出</span>
          </button>
          <button className="ms-item" onClick={() => fileRef.current?.click()}>
            <span className="mi"><Download size={20} /></span><span className="mt">导入</span>
          </button>
        </div>
        {/* 窄屏侧栏是收起的，进度搬进抽屉里，两处渲染的是同一个 Pulse */}
        <div className="ms-pulse"><Pulse state={state} /></div>
        <div className="ms-user">
          <span>{user ? user.name : ''}</span>
          <button className="ms-logout" onClick={onLogout}><LogOut size={14} /> 退出登录</button>
        </div>
        <input
          ref={fileRef} type="file" accept="application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
        />
      </div>
    </>
  );
}

/* ============================== 快速添加 ============================== */

/** 当前页面决定了「没写日期时默认落到哪」 */
function defaultDate(state: LocalState): string | null {
  const ui = state.ui;
  if (ui.nav === 'inbox') return null;
  if (ui.nav === 'calendar') return ui.cursor;
  return D.today();
}

function placeholderFor(state: LocalState): string {
  const ui = state.ui;
  if (ui.nav === 'inbox') return '丢进待办箱，不设日期（写了日期则以写的为准）';
  if (ui.nav === 'today') return '添加到今天，也可以写「后天上午 给导师发邮件」';
  if (ui.nav === 'calendar') return '添加到 ' + D.fmtMD(ui.cursor) + '，写了日期就按写的来';
  return '新建任务，回车保存';
}

export function QuickAdd({ state, onSubmit }: {
  state: LocalState;
  onSubmit: (draft: { title: string; date: string | null; time: string | null; duration?: number; repeat?: unknown }, openDetail: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [pendingTime, setPendingTime] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed: ParseOut | null = text.trim() ? parse(text) : null;
  const chips: [string, string][] = [];
  if (parsed?.date) chips.push(['date', D.relLabel(parsed.date)]);
  if (parsed?.time) chips.push(['time', parsed.time]);
  if (parsed?.duration) chips.push(['dur', D.fmtDuration(parsed.duration)]);
  if (parsed?.repeat) chips.push(['rep', repeatLabel(parsed.repeat)]);

  const submit = (openDetail: boolean) => {
    const raw = text.trim();
    if (!raw) return;
    const p = parse(raw);
    const date = p?.date ?? defaultDate(state);
    const time = p?.time ?? pendingTime;
    setText('');
    setPendingTime(null);
    onSubmit({
      title: (p?.title || raw),
      date,
      time,
      duration: p?.duration ?? undefined,
      repeat: p?.repeat ?? undefined,
    }, openDetail);
  };

  // 「N」聚焦输入框，跟旧版一致
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); inputRef.current?.focus(); }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  return (
    <div className="fast-add" hidden={state.ui.nav === 'trash'}>
      <span className="fast-plus"><Plus size={15} /></span>
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder={placeholderFor(state)}
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
        className={'fast-clock' + (pendingTime ? ' on' : '')}
        type="button"
        title="选择时间"
        onClick={() => setPendingTime((t) => (t ? null : D.minToTime(9 * 60)))}
      >
        <Clock size={15} />
        {pendingTime && <span className="fc-time">{pendingTime}</span>}
      </button>
      <span className="fast-hint">Ctrl + Enter 打开详细设置</span>

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
  );
}

/* ============================== 外壳 ============================== */

export function Shell({
  state, user, contentRef, onNav, onNew, onExport, onImport, onLogout, onTheme,
  onManageCal, onInvites, topbar, quickAdd, children,
}: {
  state: LocalState; user: PublicUser | null;
  contentRef: React.RefObject<HTMLDivElement>;
  onNav: (k: string) => void;
  onNew: () => void;
  onExport: () => void;
  onImport: (f: File) => void;
  onLogout: () => void;
  onTheme: () => void;
  onManageCal: () => void;
  onInvites: () => void;
  topbar: ReactNode;
  quickAdd: ReactNode;
  children: ReactNode;
}) {
  const narrow = useIsNarrow();
  const [more, setMore] = useState(false);

  return (
    <div className="app">
      {!narrow && (
        <Sidebar
          state={state} onNav={onNav} onNew={onNew}
          onExport={onExport} onImport={onImport} onLogout={onLogout}
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
        user={user} onNav={onNav} onTheme={onTheme} onExport={onExport}
        onImport={onImport} onLogout={onLogout}
        onManageCal={onManageCal} onInvites={onInvites}
      />
    </div>
  );
}
