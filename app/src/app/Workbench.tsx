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
import { useConfirm, toast } from '../ui/kit.tsx';
import { DndProvider, useTimelineDrag } from '../ui/dndkit.tsx';
import { Shell, Topbar, CalSubheader, QuickAdd } from '../ui/Shell.tsx';
import { InviteSheet } from '../ui/Calendars.tsx';
import { ProjectSheet } from '../ui/ProjectSheet.tsx';
import { Drawer } from '../ui/Drawer.tsx';
import { useViewLayout } from '../views/Calendar.tsx';
import { useNav } from './useNav.ts';
import { useTaskActions } from './useTaskActions.ts';
import { useContentEvents } from './useContentEvents.ts';
import { useDeniedToast } from './useDeniedToast.ts';
import { useResizeTimeline } from './resizeTimeline.ts';
import { useKeyboard } from './keyboard.ts';
import { useBackup } from './backup.ts';
import { contentDispatch } from './contentDispatch.tsx';

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
  useViewLayout(contentRef, key, state.ui.nav, state.ui.view, state.ui.cursor);

  /* -------- 拖放 -------- */
  const timelineDrag = useTimelineDrag();

  /* -------- 导航 -------- */
  const { nav, shift } = useNav();

  /* -------- 任务操作 -------- */
  const { createTask, removeTask } = useTaskActions(setOpenId);

  /* -------- 点击委托（唯一那一个 onClick，挂 `#content` 上）-------- */
  useContentEvents(contentRef, { confirm, nav, setOpenId });

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
    nav,
    onExport,
    onImport,
    onLogout,
    onInvites: () => setInvOpen(true),
    onNewProject: () => setPjSheet('new'),
    onEditProject: (id) => setPjSheet({ id }),
    onNextProject: (id, v) => store.patchProject(id, { next: v }),
    onAddHabit: (t) => { store.addHabit(t); toast('已添加打卡项：' + t); },
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
                时用户完全不知道为什么内容不变 */}
            {!!state.lastError && (
              <div className="mx-4 mb-2 rounded-[var(--r-lg)] bg-[var(--danger-soft)]
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