/**
 * Topbar.tsx —— 顶栏 + 日程页副header + 搜索框
 */

import { useEffect, useRef } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CloudOff, Loader2 } from 'lucide-react';
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { useOutsideClose, useOnline } from '../hooks.ts';
import { CalMenu } from '../Calendars.tsx';
import { Btn } from '../kit.tsx';
import { JumpPop } from './JumpPop.tsx';
import { SearchInput, useSearchValue } from './SearchInput.tsx';

/* ============================ 副header ============================ */

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
  /** 「找日期」键自己，给 JumpPop 的 outside-close 当例外 */
  const jumpBtn = useRef<HTMLButtonElement>(null);
  let atToday = ui.cursor === t0;
  if (ui.view === 'week') atToday = D.weekStart(ui.cursor) === D.weekStart(t0);
  else if (ui.view === '3day') atToday = ui.cursor === t0;
  else if (ui.view === 'month') {
    const a = D.parseISO(ui.cursor), b = D.parseISO(t0);
    atToday = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  // 副header **只放控件**。日期长文本在顶栏（就在上面一行的标题里）——
  // 两行各报一次日期，读的人不知道该看哪一行。
  return (
    <div className="cal-subhead">
      <div className="date-nav">
        <Btn variant="normal" size="sm" title="上一个" onClick={() => onShift(-1)}>
          <ChevronLeft size={15} />
        </Btn>
        <Btn variant="normal" size="sm" title="下一个" onClick={() => onShift(1)}>
          <ChevronRight size={15} />
        </Btn>
        {/* 只留一个「今」字。在不在今天**不靠文字**，靠 `aria-pressed` 那一档配色
            （--primary 字 + --primary-pale 底 + 描边 + 加粗）—— 见 styles/shell.css
            里 `.date-nav [aria-pressed="true"]`。
            **就在今天才亮**（需求 6）：和日 / 周 / 月三个视图档同一个语义。 */}
        <Btn
          variant="normal"
          size="sm"
          aria-pressed={atToday}
          title={atToday ? '当前就在今天' : '跳回今天'}
          onClick={onToday}
        >今</Btn>
        <div className={"jump-wrap"}>
          <Btn
            ref={jumpBtn}
            variant="normal"
            size="sm"
            aria-expanded={jump}
            title="跳到指定日期（快捷键 D）"
            aria-haspopup="dialog"
            onClick={() => setJump(!jump)}
          >
            <span className={"jb-ico"}><CalendarDays size={13} /></span>
          </Btn>
          <JumpPop
            open={jump}
            cursor={ui.cursor}
            state={state}
            onPick={(d) => { onCursor(d); setJump(false); }}
            onClose={() => setJump(false)}
            triggerRef={jumpBtn}
          />
        </div>
      </div>
      <div className="view-switch">
        <button data-view="day" className={ui.view === 'day' ? 'on' : ''} onClick={() => onView('day')}>日</button>
        <button data-view="3day" className={ui.view === '3day' ? 'on' : ''} onClick={() => onView('3day')}>三</button>
        <button data-view="week" className={ui.view === 'week' ? 'on' : ''} onClick={() => onView('week')}>周</button>
        <button data-view="month" className={ui.view === 'month' ? 'on' : ''} onClick={() => onView('month')}>月</button>
      </div>
    </div>
  );
}

/* ============================== 顶栏 ============================== */

export function Topbar({ state, narrow, searchOpen, setSearchOpen, onSearch }: {
  state: LocalState; narrow: boolean;
  searchOpen: boolean; setSearchOpen: (v: boolean) => void;
  onSearch: (kw: string) => void;
}) {
  const ui = state.ui;
  const online = useOnline();
  const [kw, setKw] = useSearchValue(ui.search, onSearch);
  /** 搜索键自己。搜索槽的 outside-close 要拿它当例外，否则点它关不掉 */
  const searchBtn = useRef<HTMLButtonElement>(null);
  /** 整个搜索槽（钮 + 输入框）。outside-close 认它，点输入框里面不算点到外面 */
  const slotRef = useRef<HTMLDivElement>(null);
  useOutsideClose(slotRef, searchOpen, () => setSearchOpen(false), searchBtn);
  /* 输入框**一直在 DOM 里**（靠宽度 0 收起），`autoFocus` 只在挂载那一下生效 ——
     所以张开时得自己把焦点送进去。不送的话：键盘用户 Tab 不到、Esc 那条路也是断的。 */
  useEffect(() => {
    if (!searchOpen) return;
    const el = slotRef.current?.querySelector('input');
    if (el) el.focus();
  }, [searchOpen]);

  // 标题写**具体日期**，不写「日 / 周 / 月」。后者跟侧栏那一项重复，
  // 而用户在日程页真正想确认的就是「我现在看的是哪天」。
  // 粒度跟着视图走：日 = 某天 · 周 = 这一周的起止 · 月 = 年月。
  // 周视图原先跟月视图一样写「2026年10月」，看不出「这一周是哪一周」。
  let title = '今天';
  let range = D.fmtFull(D.today());
  if (ui.nav === 'inbox') { title = '待办箱'; range = '没有日期的事先放这儿'; }
  else if (ui.nav === 'overdue') { title = '逾期'; range = '没做完的，重新安排一下'; }
  else if (ui.nav === 'done') { title = '已完成'; range = ''; }
  else if (ui.nav === 'trash') { title = '垃圾箱'; range = ''; }
  else if (ui.nav === 'habits') { title = '打卡'; range = '坚持每天的小事'; }
  else if (ui.nav === 'ai') { title = 'AI'; range = '问它排期上的事'; }
  // 页名归**顶栏**（用户 2026-10-09：「设置页的 header 的左上角没有设置字样」，
  // 要求就是写进 header 里）。设置页那张 tab 栏是**页内的分段开关**，不是 header，
  // 所以页名只此一处 —— 顶栏写、页面里就别再写一遍，否则两行都是「设置」。
  else if (ui.nav === 'settings') { title = '设置'; range = ''; }
  else if (ui.nav === 'calendar') {
    // 日期长文本归顶栏（就在这一行）—— 副header 只放控件，别把同一天写两遍
    const ws = D.weekStart(ui.cursor);
    title = ui.view === 'day'
      ? D.fmtMD(ui.cursor)
      : ui.view === '3day'
        ? D.fmtMD(ui.cursor) + ' – ' + D.fmtMD(D.addDays(ui.cursor, 2))
      : ui.view === 'week'
        ? D.fmtMD(ws) + ' – ' + D.fmtMD(D.addDays(ws, 6))
        : D.parseISO(ui.cursor).getFullYear() + '年' + (D.parseISO(ui.cursor).getMonth() + 1) + '月';
    range = '';
  }

  return (
    // 顶栏**不加** position / z-index / sticky，见文件头注释
    <header className="topbar">
      <div className="topbar-left">
        {title && <h1 className="view-title">{title}</h1>}
        {!narrow && !!range && <span className="date-range">{range}</span>}
      </div>

      <div className="topbar-right">
        {/* 日程集多选：全局状态，顶栏哪儿都看得见（今天 / 逾期 / 待办箱是跨集的）。
            窄屏不渲染 —— 那边走「更多」抽屉里的入口 + 弹窗面板。 */}
        {!narrow && <CalMenu state={state} />}
        {narrow ? (
          /* 放大镜**原地张开成桌面端那个搜索框**（用户 2026-10-09 三轮：
             ①「把原来的搜索图标原地变成带搜索图标的输入框，带有动态的向左伸出去的
             动画」；②「移动端打开最好和桌面端完全一样」；③「动画还是太跳了，
             大幅度平滑，包括形状的移动」）。
             做法：**只有一样东西** —— 桌面端那个 `.search-box` 本身。收起时它是
             28px 宽、描边和底色全透明、放大镜居中，看着就是顶栏那个裸放大镜；
             张开时它自己长到 176px、描边底色显出来、放大镜挪到 12px 处 —— 形状是
             **连续**长出来的，不是「一个东西淡出、另一个淡入」，中途也不会被裁掉
             半条边。槽在 `.topbar-right` 里靠右对齐，所以是**往左**长、右沿钉在原地。
             那个钮**自己不画图标**，只是一层透明命中区 —— 收起时你看到的那枚放大镜
             就是框里这枚，所以三处永远是同一枚、同一个尺寸、同一个位置。
             **别做成浮层**：浮层要 `position: absolute` + 一个定位锚，放大镜和框
             看着是分开的两样东西，也没有「长出来」的动势。 */
          <div
            className={'search-slot' + (searchOpen ? ' open' : '') + (kw ? ' has-kw' : '')}
            ref={slotRef}
          >
            <div className={"search-slot-field"}>
              <SearchInput kw={kw} setKw={setKw} />
            </div>
            {/* 这里不用 `IconBtn`：它要 `children`，而这个钮**故意没有图标**
                （图标归框，否则收起和张开是两枚、尺寸位置迟早对不上）。
                名字照样有 —— `aria-label` 就是它的可访问名字。 */}
            <button
              ref={searchBtn}
              type="button"
              aria-label="搜索任务"
              title="搜索任务"
              aria-expanded={searchOpen}
              className={'icon-btn search-toggle'}
              onClick={() => setSearchOpen(!searchOpen)}
            />
          </div>
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
