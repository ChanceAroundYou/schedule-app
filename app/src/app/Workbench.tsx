/**
 * Workbench.tsx —— 主工作台组件（**只管组装**，判断都在旁边那几个文件里）
 *
 * 这里剩下的是「唯一知道全部状态的地方」必须亲自做的事：订阅两份 state、
 * 管那几个浮层的开关、把各处的回调接起来。按职责拆到了同目录：
 *
 *   useNav.ts           换页 / 挪游标
 *   useTaskActions.ts   新建、删除、上下移（每件做完都要说一句话）
 *   useContentEvents.ts `#content` 上那组原生监听
 *   clickDispatch.ts    那一个 onClick 靠 data-* 分派 —— 委托的理由在那里
 *   pickDate.ts         行内「改到…」的离屏 input
 *   useDeniedToast.ts   写权限被挡时说清是哪个集
 *   contentDispatch.tsx 按 nav 选视图
 *   resizeTimeline · keyboard · backup · domWindow · navLabel
 *
 * **auth 门禁不在这里** —— 没登录只渲染登录页，连 store 都不落地（否则一个
 * 没账户的浏览器会先写一份本机数据，登录后再往里倒）。那道门在 app.tsx。
 *
 * 下面那棵 JSX **故意不再拆**：它是一棵声明式的树，每个 prop 都直接给到真正
 * 需要它的那个组件，再包一层只会把同一份清单抄两遍。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicUser } from '../domain/types.ts';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import * as engine from '../sync/engine.ts';
import { useStoreState, useScopedState, useIsNarrow, useKeyboardInset } from '../ui/hooks.ts';
import * as T from '../ui/theme.ts';
import { useConfirm } from '../ui/kit.tsx';
import { DndProvider, useTimelineDrag } from '../ui/dndkit.tsx';
import { Shell, Topbar, CalSubheader, QuickAdd } from '../ui/Shell.tsx';
import { InviteSheet } from '../ui/Calendars.tsx';
import { ProjectSheet } from '../ui/overlays/ProjectSheet.tsx';
import { DeleteRepeatSheet, type DeleteRepeatChoice } from '../ui/kit/DeleteRepeatSheet.tsx';
import { seriesRootOf } from '../domain/repeat.ts';
import { navLabel } from './navLabel.ts';
import { toast } from '../ui/kit.tsx';
import { Drawer } from '../ui/Drawer.tsx';
import { useViewLayout } from '../views/Calendar.tsx';
import { useNav } from './useNav.ts';
import { useTaskActions } from './useTaskActions.ts';
import { useContentEvents } from './useContentEvents.ts';
import { useDeniedToast } from './useDeniedToast.ts';
import { useResizeTimeline } from './resizeTimeline.ts';
import { useKeyboard } from './keyboard.ts';
import { useBackup } from './backup.tsx';
import { contentDispatch } from './contentDispatch.tsx';
import { installTouchDamp, attachScrollThumb } from './touchDamp.ts';
import { initKeyboard } from './kb.ts';
import { captureTap } from './tapSnap.ts';
import { settleDraftAndSet, draftEcho } from '../ui/newCell.ts';
import { publishWidgetSnapshot } from '../data/widget.ts';

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
  /** 删除重复任务时的「删哪些」浮层；null = 没在问（2026-10-14） */
  const [delRepeat, setDelRepeat] = useState<{ id: string; title: string; date: string | null } | null>(null);
  const [invOpen, setInvOpen] = useState(false);
  /** 找日期面板与「更多」抽屉的开关放在这里 —— Esc 要按一个固定顺序逐层关 */
  const [jumpOpen, setJumpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 搜索浮条（移动端）的开关 —— Esc 关闭顺序：more → search → jump → drawer */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 项目浮层：`'new'` = 新建，`{ id }` = 编辑那个项目，`null` = 关着。
   *  用一个状态而不是两个布尔 —— 两开两关必然有一条路径忘了关另一个。 */
  const [pjSheet, setPjSheet] = useState<'new' | { id: string } | null>(null);
  /**
   * **实际生效**的那一档（`auto` 已经解析过了），不是偏好 —— 设置页
   * 外观卡里的色点要按它渲染（暗档的主色是提亮过的另一套值）。
   */
  const [theme, setTheme] = useState<'light' | 'dark'>(() => T.resolveTheme(store.get().ui.theme));

  /* -------- 外观三轴 + 卡片字号档 -------- */
  // 任一变化都重写一遍：applyAppearance 幂等，写同样的值没副作用，
  // 所以不需要在这里挑是哪一轴变了。
  // ⚠️ `cardFontSize` 必须在依赖里：它是靠 applyAppearance 写
  // `<html data-card-font>` 生效的，漏在这一列里就是「设置里换了档、屏幕不动」，
  // 要等下次换配色或刷新页面才看得见。
  useEffect(() => { setTheme(T.applyAppearance(state.ui)); },
    [state.ui.theme, state.ui.accent, state.ui.style, state.ui.cardFontSize]);

  // 跟随系统：只在 auto 档订阅。切走时 effect 重跑 → 退订
  useEffect(() => {
    if (state.ui.theme !== 'auto') return;
    return T.watchSystemTheme(() => setTheme(T.applyAppearance(store.get().ui)));
  }, [state.ui.theme]);

  /* -------- 桌面小组件快照 --------
   *
   * 数据一变就重写快照。**用整个 state 当依赖**是有意的：改标题、勾完成、
   * 拖拽换日、同步拉回 —— 这些都该让桌面跟着变，逐个字段列举必然会漏。
   * publishWidgetSnapshot 内部是「写 SharedPreferences + 发广播」，
   * 静默失败（失败也只是桌面没更新，不影响用户正在做的事）。
   */
  useEffect(() => { void publishWidgetSnapshot(state); }, [state]);

  /* -------- 键盘 + 落点快照 --------
   *
   * 1. `initKeyboard()`：原生壳里订阅系统的键盘弹起/收起（见 app/kb.ts）。
   *    没有它，「收起键盘 → 撤掉空草稿」就永远触发不了 ——
   *    （原生壳里键盘是盖在界面上的，拿 visualViewport 差值算恒等于 0）。
   * 2. `captureTap`：在 pointerdown（布局还没变）把「这是几点」算完存起来。
   *    click 里只取结果，避免「按下时的坐标 + 抬起时的布局」混用。
   * 3. 兜底结算：点 `#content` 之外的地方（底部导航、顶栏）也要收掉草稿；
   *    `#content` 以内的由 clickDispatch 统一收尾。
   */
  useEffect(() => {
    const offKb = initKeyboard();
    // 未定时区滚到头的橡皮筋 + 浮动滚动条（见 touchDamp.ts）。委托在 #content
    // 上装一次，视图里不用管；容器不存在时它们自己什么都不做。
    const content = contentRef.current;
    const offDamp = content ? installTouchDamp(content) : null;
    const offThumb = content ? attachScrollThumb(content) : null;
    document.addEventListener('pointerdown', captureTap, true);
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('.new-cell')) return;
      if (t.closest('#content')) return;     // 内部由 clickDispatch 收尾，别重复
      /* ⚠️ **回声**（2026-10-22 抓到的真 bug，用户报的是「点加号没反应」）：
         开草稿那次渲染会把手指点中的那一格换掉（`.allday-blank` 少一个孔位），
         浏览器于是把这一下 click 补发给最近的祖先（body）—— 对这条兜底来说
         跟「用户点了侧栏」一模一样，刚开出来的草稿被自己那一下当场关掉，
         一帧都看不见。刚开过草稿的那 450ms 里，这一下不算数。详见 newCell.ts。 */
      if (draftEcho()) return;
      /* 目标根本不是元素（document / body / html）：同样只可能是补发的尾巴 */
      if (t === document.body || t === document.documentElement) return;
      settleDraftAndSet(null);
    };
    document.addEventListener('click', onDocClick);
    return () => {
      offKb();
      if (offDamp) offDamp();
      if (offThumb) offThumb();
      document.removeEventListener('pointerdown', captureTap, true);
      document.removeEventListener('click', onDocClick);
    };
  }, []);

  /* -------- 视图尺寸 + 滚动位置 -------- */
  const key = `${state.ui.nav}|${state.ui.view}|${state.ui.cursor}`;
  useViewLayout(contentRef, key, state.ui.nav, state.ui.view, state.ui.cursor);

  /* -------- 重复任务：翻到远处时按需把窗口补过去 --------
   * 默认窗口只铺到「今天 + 120 天」（见 REPEAT_HORIZON_DAYS）。用户翻到更远的
   * 月份时，把目标日期推过去 —— 否则他会发现「某一天之后突然全没了」
   * （2026-10-17 用户报 2027-01-23 之后消失）。幂等：已经铺到位就什么也不做。 */
  useEffect(() => {
    if (state.ui.nav !== 'calendar') return;
    const c = state.ui.cursor;
    let end = c;
    if (state.ui.view === 'week') end = D.addDays(D.weekStart(c), 6);
    else if (state.ui.view === '3day') end = D.addDays(c, 2);
    else if (state.ui.view === 'month') {
      const d = D.parseISO(c);
      const last = D.lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
      end = `${d.getFullYear()}-${D.pad(d.getMonth() + 1)}-${D.pad(last)}`;
    }
    // 多看 45 天，翻页时不会「刚滚过去又断」
    store.ensureRepeatOccurrences({ until: D.addDays(end, 45) });
  }, [state.ui.nav, state.ui.view, state.ui.cursor]);

  /* -------- 拖放 -------- */
  const timelineDrag = useTimelineDrag();

  /* -------- 导航 -------- */
  const { nav, shift } = useNav();

  /* -------- 任务操作 -------- */
  const { createTask, removeTask } = useTaskActions(setOpenId, setDelRepeat);

  /** 删除重复任务：先问「删哪些」，再动手（2026-10-14） */
  const onDeleteRepeat = useCallback((c: DeleteRepeatChoice) => {
    const ask = delRepeat;
    setDelRepeat(null);
    if (!ask || c === 'cancel') return;
    const t = store.get().tasks[ask.id];
    if (!t) return;
    const root = seriesRootOf(t) ?? t.id;
    if (c === 'one') {
      // 删这一次：规则保留，下一次照常出现
      store.deleteOne(root, ask.date ?? D.today(), navLabel(store.get().ui.nav));
      toast('已跳过这一次', { label: '撤销', run: () => store.restoreTask(t.id) });
    } else {
      store.deleteSeriesFrom(root, ask.date ?? D.today(), navLabel(store.get().ui.nav));
      const kept = (t.date ?? '') < (ask.date ?? '') ? '，之前的历史保留' : '';
      toast('已删除这一次及以后的所有重复' + kept);
    }
  }, [delRepeat]);

  /* -------- 点击委托（唯一那一个 onClick，挂 `#content` 上）-------- */
  useContentEvents(contentRef, { confirm, nav, setOpenId, onProject: setPjSheet });

  /* -------- 拉伸时间轴上下沿（鼠标）-------- */
  useResizeTimeline(contentRef);

  /* -------- 键盘 -------- */
  useKeyboard({ shift, nav, openId, setOpenId, moreOpen, setMoreOpen, jumpOpen, setJumpOpen, searchOpen, setSearchOpen });

  /* -------- 导出 / 导入 -------- */
  const { exportBackup: onExport, importBackup: onImport } = useBackup();

  /* -------- 被权限挡下的改动要说出来 -------- */
  useDeniedToast(state);

  /* -------- 内容分发 -------- */
  const body = contentDispatch(state, scoped, user, theme, {
    onExport,
    onImport,
    onLogout,
    onInvites: () => setInvOpen(true),
    onAiConfirmed: () => void engine.syncNow(),
  });

  // 搜索词只有一个写入方（顶栏那个框 / 浮条）。用 useCallback 定住身份，
  // 否则 useSearchValue 里那个 effect 会每渲染跑一遍（它的依赖里有 onSearch）。
  const onSearch = useCallback((kw: string) => {
    if (kw !== store.get().ui.search) store.setUi({ search: kw });
  }, []);

  return (
    <DndProvider
      modifiers={timelineDrag.modifiers}
      onDragOver={timelineDrag.onDragOver}
      onDragMove={timelineDrag.onDragMove}
      onDragEnd={timelineDrag.onDragEnd}
      onDragCancel={timelineDrag.onDragCancel}
    >
      <Shell
        state={state}
        contentRef={contentRef}
        onNav={nav}
        onInvites={() => setInvOpen(true)}
        /* 「更多」抽屉 / 找日期面板的开关都在这一层：Esc 要按
           抽屉 > 找日期 的顺序关，只有同时看得见这两者的地方才排得出顺序 */
        more={moreOpen}
        setMore={setMoreOpen}
        topbar={
          <>
            <Topbar
              state={state}
              narrow={narrow}
              searchOpen={searchOpen}
              setSearchOpen={setSearchOpen}
              onSearch={onSearch}
            />
            {state.ui.nav === 'calendar' && (
              <CalSubheader
                state={state}
                jump={jumpOpen}
                setJump={setJumpOpen}
                onView={(v) => store.setUi({ view: v })}
                onShift={shift}
                onToday={() => {
                  const stay = store.get().ui.nav === 'calendar';
                  store.setUi(stay ? { cursor: D.today() } : { cursor: D.today(), nav: 'today' });
                  setJumpOpen(false);
                }}
                onCursor={(iso) => { store.setUi({ cursor: iso, nav: 'calendar' }); setJumpOpen(false); }}
              />
            )}
            {/* 同步报错原来只写进 state 没人渲染，等于没有 —— 断网 / 时钟不对
                时用户完全不知道为什么内容不变。右上角 ✕ 只清显示不拦下次同步：
                下一轮还报错会再弹出来，不会把问题藏住 */}
            {!!state.lastError && (
              <div className="wb-err mx-4 mb-2 flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1">{state.lastError}</span>
                <button
                  type="button"
                  aria-label="关闭同步提示"
                  data-wb="dismiss-error"
                  className="shrink-0 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[14px] leading-none opacity-70 hover:opacity-100"
                  onClick={() => store.setError(null)}
                >
                  ✕
                </button>
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
        <div style={{ display: 'contents' }}>
          {body}
        </div>

        <Drawer
          state={state}
          id={openId}
          onClose={() => setOpenId(null)}
          onPatch={store.patchTask}
          onMoveToCal={(id, calId) => store.moveToCal('task', id, calId)}
          onToggle={(id) => store.toggleTask(id)}
          onDelete={removeTask}
          onDismissConflict={store.dismissConflict}
        />

        {/* 两个浮层都传全量 state：它们要读 cals / invites，那是跨集的东西 */}
        <DeleteRepeatSheet
          open={!!delRepeat}
          title={delRepeat?.title ?? ''}
          date={delRepeat?.date ?? null}
          onChoose={onDeleteRepeat}
        />

        <InviteSheet state={state} open={invOpen} onClose={() => setInvOpen(false)} />
        {pjSheet && (
          <ProjectSheet
            state={state}
            id={pjSheet === 'new' ? null : pjSheet.id}
            onClose={() => setPjSheet(null)}
          />
        )}
      </Shell>
    </DndProvider>
  );
}

export { Workbench };