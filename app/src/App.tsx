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
import type { Project, PublicUser, Task } from './domain/types.ts';
import * as D from './domain/date.ts';
import * as store from './data/store.ts';
import { ApiError, api, getCachedUser, getToken, setCachedUser, setToken } from './data/api.ts';
import * as engine from './sync/engine.ts';
import { readLegacy } from './data/legacy.ts';
import { useStoreState, useScopedState, useIsNarrow, useKeyboardInset, LONG_PRESS_MS } from './ui/hooks.ts';
import * as T from './ui/theme.ts';
import { ConfirmProvider, ToastHost, useConfirm, toast } from './ui/kit.tsx';
import { useDragLayer } from './ui/dnd.ts';
import { HOUR_H, DAY_H } from './domain/layout.ts';
import { Auth } from './ui/Auth.tsx';
import { Shell, Topbar, QuickAdd } from './ui/Shell.tsx';
import { InviteSheet, ManageSheet } from './ui/Calendars.tsx';
import { ProjectSheet } from './ui/ProjectSheet.tsx';
import { Drawer } from './ui/Drawer.tsx';
import { ActSheet } from './ui/ActSheet.tsx';
import { CalendarView, useViewLayout } from './views/Calendar.tsx';
import { DoneView, InboxView, OverdueView, TodayView } from './views/Lists.tsx';
import { HabitsView } from './views/Habits.tsx';
import { TrashView } from './views/Trash.tsx';
import { ProjectsView } from './views/Projects.tsx';
import { SettingsView } from './ui/Settings.tsx';

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
  // 手机软键盘的高度写进 --kb，给抽屉 / Sheet 避让（见 hooks.ts 里那段注释）
  useKeyboardInset();
  const confirm = useConfirm();
  const contentRef = useRef<HTMLDivElement>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [actId, setActId] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  /** 找日期面板与「更多」抽屉的开关放在这里 —— Esc 要按一个固定顺序逐层关 */
  const [jumpOpen, setJumpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 项目浮层：`'new'` = 新建，`{ id }` = 编辑那个项目，`null` = 关着。
   *  用一个状态而不是两个布尔 —— 两开两关必然有一条路径忘了关另一个。 */
  const [pjSheet, setPjSheet] = useState<'new' | { id: string } | null>(null);
  /**
   * **实际生效**的那一档（`auto` 已经解析过了），不是偏好 —— 设置页
   * 外观卡里的色点要按它渲染（暗档的主色是提亮过的另一套值）。
   */
  const [theme, setTheme] = useState<'light' | 'dark'>(() => T.resolveTheme(store.get().ui.theme));

  /* -------- 外观三轴 -------- */
  // 三轴任一变化都重写一遍：applyAppearance 幂等，写同样的值没副作用，
  // 所以不需要在这里挑是哪一轴变了。
  useEffect(() => { setTheme(T.applyAppearance(state.ui)); },
    [state.ui.theme, state.ui.accent, state.ui.style]);

  // 跟随系统：只在 auto 档订阅。切走时 effect 重跑 → 退订
  useEffect(() => {
    if (state.ui.theme !== 'auto') return;
    return T.watchSystemTheme(() => setTheme(T.applyAppearance(store.get().ui)));
  }, [state.ui.theme]);

  /* -------- 视图尺寸 + 滚动位置 -------- */
  const key = `${state.ui.nav}|${state.ui.view}|${state.ui.cursor}`;
  useViewLayout(contentRef, key, state.ui.nav, state.ui.view);

  /* -------- 拖放 -------- */
  // 触屏「提起后原地松手」= 长按本来的意思，弹操作层。打卡行没有操作层，忽略
  const drag = useDragLayer(contentRef, (id, kind) => { if (kind === 'task') setActId(id); });

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
    // **只挪光标，不改当前在哪一页。** 写 `nav: 'calendar'` 的话，在待办箱 /
    // 已完成 / 打卡这几页按方向键会被强行拽到日历页 —— 方向键没有「换页」的意思
    store.setUi({ cursor });
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
    const st = store.get();
    // 每一处放弃都要说一句为什么。静默失败是最糟的一类反馈 ——
    // 用户点了没反应，只会以为程序卡了
    if (st.tasks[id] && !st.tasks[id].date) { toast('先给它定个日期'); return; }
    const scope = scopeFor(st, id);
    if (scope.length < 2) { toast(scope.length ? '这里只有它一个' : '这一屏没法排序'); return; }
    const idx = scope.indexOf(id);
    const next = idx + dir;
    if (next < 0) { toast('已经是第一个了'); return; }
    if (next >= scope.length) { toast('已经是最后一个了'); return; }
    const rest = scope.slice();
    rest.splice(idx, 1);
    rest.splice(next, 0, id);
    store.reorder('task', rest);
  }, []);

  /* -------- 长按（触屏没有 hover；拖拽走 dnd 那条 pointer 通路）-------- */
  const lp = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean; x: number; y: number }>(
    { timer: null, fired: false, x: 0, y: 0 });
  const clearLp = () => { if (lp.current.timer) { clearTimeout(lp.current.timer); lp.current.timer = null; } };
  const pointerDown = (e: React.PointerEvent) => {
    /* **这一行必须排在鼠标那次 return 之前。** 它清的是「吞掉抬手补的那记
       click」的标志，而标志只有非鼠标长按会设上 —— 于是鼠标这条路原来直接
       return，标志就一直挂在 true 上，把长按之后用鼠标点的第一下静默吃掉。
       真手指点下一次时有自己的 pointerdown，能清掉它；探针的合成 `.click()`
       没有 pointerdown，所以曾经要靠点两次才过（第一次什么动静都没有）。 */
    lp.current.fired = false;

    // 鼠标继续走 HTML5 拖拽，长按只服务触屏
    if (e.pointerType === 'mouse') return;
    // 打卡行也能拖（列表排序那套对它是通用的），但操作层只服务任务
    const el = (e.target as HTMLElement).closest<HTMLElement>('.task-el, .habit-row');
    const id = el?.dataset.id;
    if (!id || !el) return;
    lp.current.x = e.clientX;
    lp.current.y = e.clientY;
    clearLp();
    lp.current.timer = setTimeout(() => {
      lp.current.fired = true;
      // 震一下：手指贴上屏幕时视线确实在那儿，但「抓住了」这件事需要一个
      // 不必盯着屏幕也能确认的信号。桌面浏览器没有 vibrate，不支持就算了。
      //
      // 先问一句 userActivation：**没有用户交互过就别调**。调到的话 Chrome 会
      // 直接拦下来，还往控制台打一条 error（「user hasn't tapped on the frame」）——
      // 探针里合成出来的触摸事件没有 user activation，于是每跑一次就在
      // 「离线时不许有别的报错」那条上挂一次，指向的却是个不存在的故障。
      // 真手指按下去 pointerdown 本来就算交互，这个判断不会把功能关掉；
      // 认不出 userActivation 的老浏览器（`!ua`）维持原样。
      const ua = navigator.userActivation;
      if ((!ua || ua.hasBeenActive) && typeof navigator.vibrate === 'function') navigator.vibrate(12);
      // 「提起」= 进入拖拽待命态；接下来要么拖走，要么原地松手弹操作层
      // （由 dnd 的 onTapHold 回调决定，见那边文件头）
      if (!drag.beginTouch(el, id, lp.current.x, lp.current.y)) setActId(id);
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
        case 'toggle': {
          const task = store.get().tasks[id];
          const completing = !!(task && !task.done);
          store.toggleTask(id);
          // 勾完之后这一行会从列表里让位（位子让给还没做的事）。不说一句，
          // 用户看到的就是「它凭空消失了」
          if (completing) {
            act.closest<HTMLElement>('.task-el')?.classList.add('popping');
            toast(task.date === D.today()
              ? '已完成 · 收进「今天 › 今天已完成」'
              : '已完成，收进「已完成」');
          }
          return;
        }
        case 'habit':
          store.toggleHabit(id);
          return;
        case 'toggle-tdone':
          // 「今天已完成」的展开状态要落盘：不落的话离开页面再回来就复位了
          store.setUi({ tdoneOpen: !store.get().ui.tdoneOpen });
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
      // 跳转顺带清空搜索：不然跳过去只看得见过滤剩下的几条，像是那天没内容
      store.setUi({ nav: 'calendar', view: 'day', cursor: jump.dataset.jump, search: '' });
      return;
    }
    const navBtn = el.closest<HTMLElement>('[data-nav]');
    if (navBtn?.dataset.nav) { nav(navBtn.dataset.nav); return; }
    if (el.closest('[data-jump-habits]')) { nav('habits'); return; }

    // 3) 点行 = 开抽屉。放在这一层，前面任何一个命中都不该再开抽屉
    const row = el.closest<HTMLElement>('.task-el');
    if (row?.dataset.id && !row.classList.contains('habit-row')) { setOpenId(row.dataset.id); return; }
    // 打卡条上的条目点标题不做任何事（点勾是打卡，长按改期）

    /* 4) 点日历空白 = 新建一条并直接打开抽屉。
     *
     * **必须排在「点行」之后**：任务方块本身就长在落点区域里，顺序反了会把
     * 「点开某条任务」变成「新建一条空任务」—— 而且这条空任务还排在它前面。
     *
     * 四种区域含义不同，不能统一处理：时间轴与周视图按光标纵坐标换算 15 分钟档
     * 的时间（跟拖拽、拉伸同一档）；全天区与月视图格子只给日期不给时间。
     */
    const zone = el.closest<HTMLElement>('[data-drop]');
    if (zone) {
      const kind = zone.dataset.drop;
      const date = zone.dataset.date || store.get().ui.cursor;
      if (kind === 'day' || kind === 'allday') {
        setOpenId(store.addTask({ title: '', date, time: null }));
        return;
      }
      if (kind === 'timeline' || kind === 'week') {
        const r = zone.getBoundingClientRect();
        const min = Math.round(((e.clientY - r.top) / DAY_H) * 1440 / 15) * 15;
        setOpenId(store.addTask({
          title: '',
          date,
          time: D.minToTime(Math.max(0, Math.min(1425, min))),
        }));
        return;
      }
    }
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

    /* 拉伸时的浮标：把「现在拉成了几点 / 多长」写在手边。
       没有它，用户只能盯着方块高度的变化去猜 —— 而 15 分钟在 64px/小时下
       只有 16px，肉眼分不出 15 和 30 的差别 */
    let tip: HTMLDivElement | null = null;
    const showTip = (el: HTMLElement | null, dur: number, timeText: string | null) => {
      if (!el) return;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'tl-resize-tip';
        document.body.appendChild(tip);
      }
      const r = el.getBoundingClientRect();
      // 上沿拖动时浮标挪到方块**上方** —— 放在下面会正好挡住正在拖的那条边
      tip.style.top = (timeText != null ? r.top - 26 : r.bottom + 6) + 'px';
      tip.style.left = r.left + 'px';
      tip.textContent = (timeText ? timeText + ' · ' : '') + D.fmtDuration(dur);
    };
    const hideTip = () => { tip?.remove(); tip = null; };

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
      showTip(rz.el, rz.dur, rz.edge === 'top' ? t.time : null);
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
      showTip(rz.el, rz.cur, rz.edge === 'top' && rz.curStart != null ? D.minToTime(rz.curStart) : null);
    };

    const up = () => {
      if (!rz) return;
      const patchFields: Partial<Task> = { duration: Math.max(15, rz.cur) };
      if (rz.edge === 'top' && rz.curStart != null) patchFields.time = D.minToTime(rz.curStart);
      rz.el?.classList.remove('resizing');
      hideTip();
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
        // 逐层关闭，一次只关一层：操作层 → 更多抽屉 → 找日期面板 → 抽屉。
        // 顺序跟旧版一致。一次全关会让用户不知道自己刚关掉了什么
        if (actId) setActId(null);
        else if (moreOpen) setMoreOpen(false);
        else if (jumpOpen) setJumpOpen(false);
        else if (openId) setOpenId(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // 时间轴上下沿的把手：方向键微调一档 15 分钟。
      // 只认「焦点在把手上」这一种情况 —— 把手是页面上仅有的两个不可点、
      // 只能拖的控件（其余 data-act 全是真 button，Tab 就能到）。
      // dir 跟着时间轴方向：往下 = +1，往上 = -1（上沿往上拖是变长，别写反）。
      const handle = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-act="resize"],[data-act="resize-top"]');
      if (handle && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const t = store.get().tasks[handle.dataset.id || ''];
        if (t) {
          store.patchTask(t.id, D.nudgeEdge(
            t.time, t.duration, handle.dataset.act === 'resize-top' ? 'top' : 'bottom',
            e.key === 'ArrowDown' ? 1 : -1,
          ));
        }
        return;
      }
      // 方向键只在 calendars / today 有意义（这两页才有「翻到哪天」这回事），
      // 而且**不换页** —— shift() 也跟着改了，不再往回塞 nav: 'calendar'
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const navNow = store.get().ui.nav;
        if (navNow !== 'calendar' && navNow !== 'today') return;
        e.preventDefault();
        shift(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        nav('calendar');
        setJumpOpen(true);   // 快捷方式的作用就该是「直接打开」，不是「切过去让你再点一下」
        return;
      }
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); nav('today'); return; }
      // 1/2/3 切日 / 周 / 月 —— **要连带切到日程页**，否则在今天 / 待办箱这些
      // 页面上按了毫无反应（视图切了，但那些页面根本不渲染视图切换按钮）
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        store.setUi({ nav: 'calendar', view: (['day', 'week', 'month'] as const)[+e.key - 1] });
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [shift, nav, actId, openId, moreOpen, jumpOpen]);

  /* -------- 导出 / 导入 -------- */
  const exportBackup = useCallback(() => {
    const s = store.get();
    const blob = new Blob([JSON.stringify({
      version: 5,
      exportedAt: Date.now(),
      tasks: Object.values(s.tasks),
      habits: Object.values(s.habits),
      projects: Object.values(s.projects),
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
    // projects 可选：**旧备份（version 4）没有这个键**，缺了就是「没有项目」，
    // 不该拒绝整个文件 —— 那会让用户以为备份坏了。
    let data: { tasks?: Task[]; habits?: never[]; projects?: Project[] };
    try {
      data = JSON.parse(await file.text());
    } catch (_) { toast('这个文件不是有效的备份'); return; }
    if (!Array.isArray(data?.tasks)) { toast('备份里没有任务数据'); return; }

    // 打卡也要导进来。**导出时是写了 habits 的，这里曾经写死传空数组** ——
    // 于是导出的备份丢光了所有打卡项，而且界面上完全看不出少了什么
    const habits = Array.isArray(data.habits) ? data.habits as never[] : [];
    const n = data.tasks.length + habits.length;
    const ok = await confirm({
      title: `导入 ${n} 条？`,
      body: `其中任务 ${data.tasks.length} 条、打卡 ${habits.length} 条。` +
        '会和现有数据合并（同 id 覆盖，其余保留），不会先清空。',
      confirmText: '导入',
    });
    if (!ok) return;
    const added = store.loadMigrated(data.tasks, habits, data.projects || []);
    toast(`已导入 ${added} 条，正在同步`);
    void engine.syncNow();
  }, [confirm]);

  /* -------- 被权限挡下的改动要说出来 -------- */
  // 只读日程集里点勾选，写入会在 store 那一层被丢在门口。不提示的话
  // 用户看到的是「点了没反应」，会以为程序坏了。
  //
  // **要说清是哪个集**：今天 / 逾期 / 待办箱是跨集的（见「五、界面约定」），
  // 在「今天」里勾了一条别的集的任务时，一句「这个日程集你只有查看权限」
  // 只会让人以为是眼前这个集出了问题。
  const deniedRef = useRef(state.denied);
  useEffect(() => {
    if (state.denied === deniedRef.current) return;
    deniedRef.current = state.denied;

    const names = state.deniedCals
      .map((id) => state.cals.find((c) => c.id === id)?.name)
      .filter((n): n is string => !!n);

    if (!names.length) {
      // 集已经不在本地了（被移出 / 刚删掉）—— 说不出名字，就说行为
      toast('改动没有保存：这个日程集你没有写入权限');
      return;
    }
    toast(names.length === 1
      ? `改动没有保存：「${names[0]}」里你只有查看权限`
      : `改动没有保存：这几个日程集你只有查看权限 —— ${names.join('、')}`);
  }, [state.denied, state.deniedCals, state.cals]);

  /* -------- 内容分发 -------- */
  let body: React.ReactNode;
  if (state.ui.nav === 'settings') {
    /**
     * 设置**放在日程集那道门禁之前**。它里面有「清空本机副本」和账户卡，
     * 而「一个集都没拿到」正是最需要点这两个的时候 —— 塞进 else 里就成了
     * 一个修不了东西的死角。传全量 state：cals / invites / outbox 都是跨集的。
     */
    body = (
      <SettingsView
        state={state}
        user={user}
        theme={theme}
        onExport={exportBackup}
        onImport={importBackup}
        onLogout={onLogout}
        onManageCal={() => setCalOpen(true)}
        onInvites={() => setInvOpen(true)}
      />
    );
  } else if (!state.cals.length) {
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
      // 按集：跟日程 / 打卡 / 已完成一样，看的是当前选中的那个集
      case 'projects':
        body = (
          <ProjectsView
            state={scoped}
            onNew={() => setPjSheet('new')}
            onEdit={(id) => setPjSheet({ id })}
            onNext={(id, v) => store.patchProject(id, { next: v })}
          />
        );
        break;
      case 'habits':
        body = <HabitsView state={scoped} onAdd={(t) => { store.addHabit(t); toast('已添加打卡项：' + t); }} />;
        break;
      default: body = <CalendarView state={scoped} />;
    }
  }

  return (
    <Shell
      state={state}
      contentRef={contentRef}
      onNav={nav}
      onNew={() => {
        const id = store.addTask({ title: '新任务', date: state.ui.nav === 'inbox' ? null : D.today() });
        setOpenId(id);
      }}
      onManageCal={() => setCalOpen(true)}
      onInvites={() => setInvOpen(true)}
      /* 「更多」抽屉 / 找日期面板的开关都在 App 这一层：Esc 要按
         actSheet > 抽屉 > 找日期 的顺序关，只有同时看得见这三者的地方才排得出顺序 */
      more={moreOpen}
      setMore={setMoreOpen}
      topbar={
        <>
          <Topbar
            state={state}
            narrow={narrow}
            jump={jumpOpen}
            setJump={setJumpOpen}
            onView={(v) => store.setUi({ view: v })}
            onShift={shift}
            onToday={() => {
              // 光标拉回今天；不在日程页时顺带回「今天」清单页。
              // 找日期面板也要关掉 —— 否则跳完它还挂在那儿挡着
              const stay = store.get().ui.nav === 'calendar';
              store.setUi(stay ? { cursor: D.today() } : { cursor: D.today(), nav: 'today' });
              setJumpOpen(false);
            }}
            onCursor={(iso) => { store.setUi({ cursor: iso, nav: 'calendar' }); setJumpOpen(false); }}
            onSearch={(kw) => { if (kw !== store.get().ui.search) store.setUi({ search: kw }); }}
          />
          {/* 同步报错原来只写进 state 没人渲染，等于没有 —— 断网 / 时钟不对
              时用户完全不知道为什么内容不变 */}
          {!!state.lastError && (
            <div className="mx-4 mb-2 rounded-lg bg-[var(--danger-soft)]
                            px-3 py-1.5 text-[12.5px] text-[var(--danger)]">
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
        onToggle={(id) => store.toggleTask(id)}
        onDelete={removeTask}
        onDismissConflict={store.dismissConflict}
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
      {pjSheet && (
        <ProjectSheet
          state={state}
          id={pjSheet === 'new' ? null : pjSheet.id}
          onClose={() => setPjSheet(null)}
        />
      )}
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
    // 首屏前先上一次色，别等 Workbench 那个 effect（它在这次 render 之后才跑）
    T.applyAppearance(store.get().ui);

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
