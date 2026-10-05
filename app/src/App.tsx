/**
 * App.tsx —— 串起来的那一层
 *
 * 三件事都集中在这里，各有原因：
 *
 *   1. **点击走事件委托**（`#content` 上挂一个 onClick），不给每一行挂处理器。
 *      行是 React 渲染的，拖动落库、同步落地都会换掉节点 —— 逐行挂会跟着丢，
 *      委托挂在容器上永远有效。这也让 views/ 下的组件保持纯展示、零回调。
 *   2. **拖放、长按、拉伸** 都是跨行的连续手势，必须在容器层级统一处理。
 *   3. **auth 门禁**：没登录只渲染登录页，连 store 都不落地（否则一个
 *      没账户的浏览器会先写一份本机数据，登录后再往里倒）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicUser, Task } from './domain/types.ts';
import * as D from './domain/date.ts';
import * as store from './data/store.ts';
import { ApiError, api, getCachedUser, getToken, setCachedUser, setToken } from './data/api.ts';
import * as engine from './sync/engine.ts';
import { readLegacy } from './data/legacy.ts';
import { useStoreState, useScopedState, useIsNarrow, LONG_PRESS_MS } from './ui/hooks.ts';
import { ConfirmProvider, ToastHost, useConfirm, toast } from './ui/kit.tsx';
import { useDragLayer } from './ui/dnd.ts';
import { HOUR_H } from './domain/layout.ts';
import { Auth } from './ui/Auth.tsx';
import { Shell, Topbar, QuickAdd } from './ui/Shell.tsx';
import { InviteSheet, ManageSheet } from './ui/Calendars.tsx';
import { Drawer } from './ui/Drawer.tsx';
import { ActSheet } from './ui/ActSheet.tsx';
import { CalendarView, useViewLayout } from './views/Calendar.tsx';
import { DoneView, InboxView, OverdueView, TodayView } from './views/Lists.tsx';
import { HabitsView } from './views/Habits.tsx';
import { TrashView } from './views/Trash.tsx';

/* ============================== 主题 ============================== */

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/* ============================== 主体 ============================== */

function Workbench({ user, onLogout }: { user: PublicUser | null; onLogout: () => void }) {
  /**
   * 两份 state，用途不同，别混：
   *   state  —— 全量。今天 / 逾期 / 待办箱 / 垃圾箱 / 侧栏徽标 / 抽屉都看它，
   *             因为这几处是**跨集**的（用户既定：清单跨集）
   *   scoped —— 只含当前选中的日程集。日程 / 打卡 / 已完成看它
   * 在状态这一层分叉，views/ 下的组件就不用各自过滤一遍。
   */
  const state = useStoreState();
  const scoped = useScopedState();
  const narrow = useIsNarrow();
  const confirm = useConfirm();
  const contentRef = useRef<HTMLDivElement>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [actId, setActId] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => store.get().ui.theme);

  /* -------- 主题 -------- */
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    if (state.ui.theme !== theme) setTheme(state.ui.theme);
  }, [state.ui.theme, theme]);

  const toggleTheme = useCallback(() => {
    const next = store.get().ui.theme === 'dark' ? 'light' : 'dark';
    store.setUi({ theme: next });
    setTheme(next);
  }, []);

  /* -------- 视图尺寸 + 滚动位置 -------- */
  const key = `${state.ui.nav}|${state.ui.view}|${state.ui.cursor}`;
  useViewLayout(contentRef, key, state.ui.nav, state.ui.view);

  /* -------- 拖放 -------- */
  const drag = useDragLayer(contentRef);

  /* -------- 导航 -------- */
  const nav = useCallback((k: string) => {
    const cur = store.get().ui;
    const patch: Partial<typeof cur> = { nav: k };
    // 从别处切回「今天」时把游标拉回今天，否则还停在几天前翻过的位置
    if (k === 'today') patch.cursor = D.today();
    store.setUi(patch);
    if (k === 'calendar' && cur.cursor !== D.today() && cur.view !== 'month') {
      store.setUi({ cursor: D.today() });
    }
  }, []);

  const shift = useCallback((n: number) => {
    const ui = store.get().ui;
    const step = ui.view === 'month' ? 0 : n;
    const cursor = step
      ? D.addDays(ui.cursor, step * (ui.view === 'week' ? 7 : 1))
      : D.addMonths(ui.cursor, n);
    store.setUi({ cursor, nav: 'calendar' });
  }, []);

  /* -------- 任务操作 -------- */
  const patch = useCallback((id: string, fields: Partial<Task>) => {
    store.patchTask(id, fields);
  }, []);

  const createTask = useCallback((
    d: { title: string; date: string | null; time: string | null; duration?: number; repeat?: unknown },
    openDetail: boolean,
  ) => {
    const id = store.addTask({
      title: d.title, date: d.date, time: d.time,
      duration: d.duration, repeat: d.repeat,
      source: 'quick-add',
    });
    if (openDetail) setOpenId(id);
    else {
      const t = store.get().tasks[id];
      toast('已添加：' + t.title + (t.date ? ' · ' + D.relLabel(t.date) : '') + (t.time ? ' ' + t.time : ''));
    }
  }, []);

  const removeTask = useCallback((id: string) => {
    const t = store.get().tasks[id];
    if (!t) return;
    store.deleteTask(id, navLabel(store.get().ui.nav));
    // 撤销靠还原墓碑，不是把快照塞回去 —— 这样撤销和别的设备是同一套语义
    toast('已删除', { label: '撤销', run: () => store.restoreTask(id) });
  }, []);

  /** 侧栏上下移一位（触屏长按层的「上移 / 下移」） */
  const moveInList = useCallback((id: string, dir: -1 | 1) => {
    const ui = store.get().ui;
    const scope = scopeFor(store.get(), id);
    if (!scope.length) return;
    const idx = scope.indexOf(id);
    const next = idx + dir;
    if (next < 0 || next >= scope.length) return;
    const rest = scope.slice();
    rest.splice(idx, 1);
    rest.splice(next, 0, id);
    void ui;
    store.reorder('task', rest);
  }, []);

  /* -------- 长按（触屏没有 hover，也没有 HTML5 拖拽）-------- */
  const lp = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const clearLp = () => { if (lp.current.timer) { clearTimeout(lp.current.timer); lp.current.timer = null; } };
  const pointerDown = (e: React.PointerEvent) => {
    // 鼠标继续走拖拽，长按只服务触屏
    if (e.pointerType === 'mouse') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.task-el');
    const id = el?.dataset.id;
    if (!id) return;
    lp.current.fired = false;
    clearLp();
    lp.current.timer = setTimeout(() => {
      lp.current.fired = true;
      setActId(id);
    }, LONG_PRESS_MS);
  };

  /* -------- 点击委托 -------- */
  const onClick = useCallback(async (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;

    // 长按已经处理过了，抬手那一下补的 click 要吞掉（否则顺带打开抽屉）
    if (lp.current.fired) { lp.current.fired = false; return; }

    // 1) 行内动作
    const act = el.closest<HTMLElement>('[data-act]');
    if (act) {
      e.stopPropagation();
      const id = act.dataset.id || '';
      switch (act.dataset.act) {
        case 'toggle':
          store.toggleTask(id);
          return;
        case 'habit':
          store.toggleHabit(id);
          return;
        case 'reschedule':
          store.patchTask(id, { date: act.dataset.date || null });
          toast('已改到 ' + D.fmtMD(act.dataset.date || ''));
          return;
        case 'pick-date':
          pickDate(id);
          return;
        case 'del-habit': {
          const ok = await confirm({
            title: '删除这个打卡项？',
            body: `「${act.dataset.title}」的打卡记录会一起删掉，可以在垃圾箱里还原。`,
            confirmText: '删除', danger: true,
          });
          if (ok) { store.deleteHabit(id); toast('已删除'); }
          return;
        }
        case 'restore': {
          const kind = act.dataset.kind === 'habit' ? 'habit' : 'task';
          if (kind === 'habit') store.restoreHabit(id); else store.restoreTask(id);
          toast('已还原');
          return;
        }
        case 'purge': {
          const ok = await confirm({
            title: '彻底删除这一项？',
            body: `「${act.dataset.title}」会从所有设备上一起消失，不可撤销。`,
            confirmText: '彻底删除', danger: true,
          });
          if (ok) { store.purgeTask(id); toast('已彻底删除'); }
          return;
        }
        case 'empty-trash': {
          const n = act.dataset.count || '0';
          const ok = await confirm({
            title: `彻底删除这 ${n} 项？`,
            body: '这一步不可撤销 —— 它们会从这台设备和所有已同步的设备上一起消失。',
            confirmText: '彻底删除', danger: true,
          });
          if (ok) { store.emptyTrash(); toast('垃圾箱已清空'); }
          return;
        }
        default:
          return;
      }
    }

    // 2) 跳转 / 找日期 / 打卡管理
    const jump = el.closest<HTMLElement>('[data-jump]');
    if (jump?.dataset.jump) {
      store.setUi({ nav: 'calendar', view: 'day', cursor: jump.dataset.jump });
      return;
    }
    const navBtn = el.closest<HTMLElement>('[data-nav]');
    if (navBtn?.dataset.nav) { nav(navBtn.dataset.nav); return; }
    if (el.closest('[data-jump-habits]')) { nav('habits'); return; }

    // 3) 点行 = 开抽屉。放在最后，前面任何一个命中都不该再开抽屉
    const row = el.closest<HTMLElement>('.task-el');
    if (row?.dataset.id && !row.classList.contains('habit-row')) setOpenId(row.dataset.id);
    // 打卡条上的条目点标题不做任何事（点勾是打卡，长按改期）
  }, [confirm, nav]);

  /* -------- 「改到…」：离屏 input + showPicker ---------- */
  function pickDate(id: string): void {
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.style.cssText = 'position:fixed;left:-9999px;top:0';
    inp.value = store.get().tasks[id]?.date || D.today();
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      if (inp.value) {
        store.patchTask(id, { date: inp.value });
        toast('已改到 ' + D.fmtMD(inp.value));
      }
    });
    // 兜底清理：showPicker 被取消时不一定有 change 事件
    setTimeout(() => inp.remove(), 60000);
    const p = inp as HTMLInputElement & { showPicker?: () => void };
    if (typeof p.showPicker === 'function') p.showPicker();
    else inp.click();
  }

  /* -------- 拉伸时间轴上下沿（鼠标）-------- */
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    let rz: {
      id: string; y: number; edge: 'top' | 'bottom';
      start: number; end: number; dur: number; cur: number; curStart?: number;
      el: HTMLElement | null;
    } | null = null;

    const down = (e: MouseEvent) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('[data-act="resize"],[data-act="resize-top"]');
      if (!h) return;
      const t = store.get().tasks[h.dataset.id || ''];
      if (!t) return;
      const start = D.timeToMin(t.time) || 0;
      rz = {
        id: t.id, y: e.clientY,
        edge: h.dataset.act === 'resize-top' ? 'top' : 'bottom',
        start, end: start + (t.duration || 60), dur: t.duration || 60, cur: t.duration || 60,
        el: host.querySelector<HTMLElement>(`.tl-event[data-id="${t.id}"]`),
      };
      rz.el?.classList.add('resizing');
      e.preventDefault();
    };

    const move = (e: MouseEvent) => {
      if (!rz) return;
      const addMin = Math.round((e.clientY - rz.y) / HOUR_H * 60 / 15) * 15;
      if (rz.edge === 'top') {
        // 底边固定：不能越过底边、不能早于 0:00
        const ns = Math.max(0, Math.min(rz.end - 15, rz.start + addMin));
        rz.curStart = ns;
        rz.cur = rz.end - ns;
        if (rz.el) {
          rz.el.style.top = (ns / 1440 * 1536) + 'px';
          rz.el.style.height = (rz.cur / 1440 * 1536) + 'px';
        }
      } else {
        rz.cur = Math.max(15, rz.dur + addMin);
        if (rz.el) rz.el.style.height = (rz.cur / 1440 * 1536) + 'px';
      }
    };

    const up = () => {
      if (!rz) return;
      const patchFields: Partial<Task> = { duration: Math.max(15, rz.cur) };
      if (rz.edge === 'top' && rz.curStart != null) patchFields.time = D.minToTime(rz.curStart);
      rz.el?.classList.remove('resizing');
      const id = rz.id;
      rz = null;
      store.patchTask(id, patchFields);
    };

    host.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      host.removeEventListener('mousedown', down);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, []);

  /* -------- 键盘 -------- */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        if (actId) setActId(null);
        else if (openId) setOpenId(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); shift(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); shift(1); }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); nav('calendar'); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); nav('today'); }
      // 1/2/3 切日 / 周 / 月 —— 旧版就有，README 里也写着，别丢
      else if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        store.setUi({ view: (['day', 'week', 'month'] as const)[+e.key - 1] });
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [shift, nav, actId, openId]);

  /* -------- 导出 / 导入 -------- */
  const exportBackup = useCallback(() => {
    const s = store.get();
    const blob = new Blob([JSON.stringify({
      version: 4,
      exportedAt: Date.now(),
      tasks: Object.values(s.tasks),
      habits: Object.values(s.habits),
      ui: s.ui,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `日程备份-${D.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出备份');
  }, []);

  const importBackup = useCallback(async (file: File) => {
    let data: { tasks?: Task[]; habits?: never[] };
    try {
      data = JSON.parse(await file.text());
    } catch (_) { toast('这个文件不是有效的备份'); return; }
    if (!Array.isArray(data?.tasks)) { toast('备份里没有任务数据'); return; }

    const n = data.tasks.length;
    const ok = await confirm({
      title: `导入 ${n} 条任务？`,
      body: '备份里的任务会和现有数据合并（同 id 覆盖，其余保留），不会先清空。',
      confirmText: '导入',
    });
    if (!ok) return;
    const added = store.loadMigrated(data.tasks, []);
    toast(`已导入 ${added} 条，正在同步`);
    void engine.syncNow();
  }, [confirm]);

  /* -------- 被权限挡下的改动要说出来 -------- */
  // 只读日程集里点勾选，写入会在 store 那一层被丢在门口。不提示的话
  // 用户看到的是「点了没反应」，会以为程序坏了
  const deniedRef = useRef(state.denied);
  useEffect(() => {
    if (state.denied !== deniedRef.current) {
      deniedRef.current = state.denied;
      toast('这个日程集你只有查看权限，改动没有保存');
    }
  }, [state.denied]);

  /* -------- 长按后的 click 吞掉标志要复位 -------- */
  useEffect(() => { lp.current.fired = false; }, [actId]);

  /* -------- 内容分发 -------- */
  let body: React.ReactNode;
  if (!state.cals.length) {
    // 一个集都没有 = 还没跟服务器对上（首次离线启动）。服务器保证每个账号
    // 至少有一个集，所以这不是「空账号」而是「没同步到」，别在这里引导建集
    body = (
      <div className="empty">
        <div>还没拿到你的日程集</div>
        <div className="empty-sub">正在连接服务器，稍等一下；断网时本地内容照常显示</div>
      </div>
    );
  } else {
    switch (state.ui.nav) {
      // 跨集：清单不按集分家
      case 'inbox': body = <InboxView state={state} />; break;
      case 'today': body = <TodayView state={state} onNav={nav} />; break;
      case 'overdue': body = <OverdueView state={state} />; break;
      case 'trash': body = <TrashView state={state} />; break;
      // 按集：这几页只画当前选中的那个集
      case 'done': body = <DoneView state={scoped} />; break;
      case 'habits':
        body = <HabitsView state={scoped} onAdd={(t) => { store.addHabit(t); toast('已添加打卡项：' + t); }} />;
        break;
      default: body = <CalendarView state={scoped} />;
    }
  }

  return (
    <Shell
      state={state}
      user={user}
      contentRef={contentRef}
      onNav={nav}
      onNew={() => {
        const id = store.addTask({ title: '新任务', date: state.ui.nav === 'inbox' ? null : D.today() });
        setOpenId(id);
      }}
      onExport={exportBackup}
      onImport={importBackup}
      onLogout={onLogout}
      onTheme={toggleTheme}
      onManageCal={() => setCalOpen(true)}
      onInvites={() => setInvOpen(true)}
      topbar={
        <>
          <Topbar
            state={state}
            narrow={narrow}
            onView={(v) => store.setUi({ view: v })}
            onShift={shift}
            onToday={() => store.setUi({ cursor: D.today(), nav: 'calendar' })}
            onCursor={(iso) => store.setUi({ cursor: iso, nav: 'calendar' })}
            onTheme={toggleTheme}
            onSearch={(kw) => { if (kw !== store.get().ui.search) store.setUi({ search: kw }); }}
          />
          {/* 同步报错原来只写进 state 没人渲染，等于没有 —— 断网 / 时钟不对
              时用户完全不知道为什么内容不变 */}
          {!!state.lastError && (
            <div className="mx-4 mb-2 rounded-lg bg-[var(--danger-soft,rgba(229,72,77,.1))]
                            px-3 py-1.5 text-[12.5px] text-[var(--danger,#e5484d)]">
              {state.lastError}
            </div>
          )}
        </>
      }
      quickAdd={
        <QuickAdd
          state={state}
          onSubmit={(d, openDetail) => createTask(d, openDetail)}
        />
      }
    >
      <div
        onClick={onClick}
        onPointerDown={pointerDown}
        onPointerMove={clearLp}
        onPointerUp={clearLp}
        onPointerCancel={clearLp}
        onPointerLeave={clearLp}
        onDragStart={drag.onDragStart}
        onDragOver={drag.onDragOver}
        onDragLeave={drag.onDragLeave}
        onDrop={drag.onDrop}
        onDragEnd={drag.onDragEnd}
        style={{ display: 'contents' }}
      >
        {body}
      </div>

      <Drawer
        state={state}
        id={openId}
        onClose={() => setOpenId(null)}
        onPatch={patch}
        onDelete={removeTask}
      />
      <ActSheet
        state={state}
        id={actId}
        onClose={() => setActId(null)}
        onPatch={patch}
        onDelete={(id) => { removeTask(id); setActId(null); }}
        onOpenDrawer={(id) => { setActId(null); setOpenId(id); }}
        onMove={moveInList}
      />

      {/* 两个浮层都传全量 state：它们要读 cals / invites，那是跨集的东西 */}
      <ManageSheet state={state} open={calOpen} onClose={() => setCalOpen(false)} />
      <InviteSheet state={state} open={invOpen} onClose={() => setInvOpen(false)} />
    </Shell>
  );
}

/* ============================== 小工具 ============================== */

function navLabel(nav: string): string {
  const m: Record<string, string> = {
    inbox: '待办箱', today: '今天', overdue: '逾期',
    calendar: '日程', habits: '打卡', done: '已完成', trash: '垃圾箱',
  };
  return m[nav] || '任务列表';
}

/** 「上移 / 下移」的作用域：当前列表里能看到的那一组 */
function scopeFor(s: ReturnType<typeof store.get>, id: string): string[] {
  const t = s.tasks[id];
  if (!t) return [];
  const nav = s.ui.nav;
  let list: Task[];
  if (nav === 'inbox') list = Object.values(s.tasks).filter((x) => !x.deleted && !x.done && !x.date);
  else if (nav === 'overdue') list = Object.values(s.tasks).filter((x) => !x.deleted && !x.done && x.date && x.date < D.today() && x.date === t.date);
  else if (nav === 'done') list = Object.values(s.tasks).filter((x) => !x.deleted && x.done);
  else list = Object.values(s.tasks).filter((x) => !x.deleted && !x.done && x.date === t.date && !x.time);
  return list.slice().sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9)).map((x) => x.id);
}

/* ============================== 根组件 ============================== */

export default function App() {
  const [user, setUser] = useState<PublicUser | null>(() => getCachedUser());
  const [ready, setReady] = useState(false);

  // 启动：有 token 就先拉一次。401 说明失效了，退回登录页。
  useEffect(() => {
    store.load();
    applyTheme(store.get().ui.theme);

    let alive = true;
    (async () => {
      if (getToken()) {
        try {
          await engine.bootstrap();
          engine.start();
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            setToken(null);
            setCachedUser(null);
            setUser(null);
          }
          // 其它错误（多半是断网）不进登录页 —— 本地数据照样能用，
          // 引擎会在网络恢复后自己补推
        }
      }
      if (alive) setReady(true);
    })();

    const onHide = () => store.flushPersist();
    window.addEventListener('pagehide', onHide);
    return () => { alive = false; window.removeEventListener('pagehide', onHide); engine.stop(); };
  }, []);

  if (!ready) return null;

  if (!getToken()) {
    return (
      <ConfirmProvider>
        <Auth
          onAuthed={(u) => {
            setCachedUser(u);
            setUser(u);
            // 首次登录：服务器账号是空的就把本机旧数据搬上去（旧 key 保留，可回滚）
            void engine.bootstrap().then(() => engine.start());
          }}
        />
        <ToastHost />
      </ConfirmProvider>
    );
  }

  const legacyLeft = !!readLegacy();

  return (
    <ConfirmProvider>
      <Workbench
        user={user}
        onLogout={async () => {
          engine.stop();
          try { await api.logout(); } catch (_) { /* 网络不通也要能退出去 */ }
          setToken(null);
          setCachedUser(null);
          setUser(null);
          // 退登录**不清本地数据** —— 清了就是「换个账户登录顺手把没同步的改动删了」
          void legacyLeft;
        }}
      />
      <ToastHost />
    </ConfirmProvider>
  );
}
