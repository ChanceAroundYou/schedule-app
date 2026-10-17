/**
 * app/clickDispatch.ts —— 容器上那一个 onClick，靠 data-* 分派
 *
 * ## 为什么是委托，不是「懒得拆」
 *
 * 行是 React 渲染的：拖动排序会换掉节点、同步落地会换掉节点、勾完成会让位。
 * 挂在行上的 handler 会跟着一起消失 —— 症状是「拖完一次之后那一行点不动了」。
 * 挂在 `#content` 上的**永远在**。
 *
 * 代价是 `views/` 下的组件全部零回调、只出 `data-*` 属性。改那个约定时先看这里。
 *
 * ## 顺序不能换
 *
 * 四步是**从具体到笼统**，命中即返回：
 *   1. `[data-act]`   行内动作（勾选、删除、还原…）
 *   2. `[data-jump]` / `[data-nav]` / `[data-jump-habits]` 跳转
 *   3. `.task-el`     点行 = 开抽屉
 *   4. `[data-zone-id]` 点日历里的空格子 = 就地开一个输入框（见 openDraft）
 *
 * 第 4 步**必须排在第 3 步之后**：任务方块本身就长在那些区域里（`.task-el`），
 * 顺序反了会把「点开某条任务」变成「新建一条空任务」，而且这条空任务还排在它前面。
 *
 * ## 新增一个动作
 *
 * 在 `views/` 里给元素加 `data-act="xxx"`，然后在这里加一个 `case`。
 * **别往行上挂 onClick**（见上面那段）。
 */
import type * as React from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { toast, type ConfirmOptions } from '../ui/kit.tsx';
import { domWindow } from './domWindow.ts';
import { takeTap } from './tapSnap.ts';
import { settleDraftAndSet } from '../ui/newCell.ts';
import { pickDate } from './pickDate.ts';
import { DAY_H, snapToHour, yToMin } from '../domain/layout.ts';
import { isNarrowNow } from '../ui/hooks.ts';
import type { DraftSeed } from '../domain/types.ts';

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

export interface ClickDeps {
  confirm: ConfirmFn;
  nav: (k: string) => void;
  setOpenId: (id: string | null) => void;
  /** 项目浮层：`'new'` = 新建，`{ id }` = 编辑那个。App 那一层的状态 */
  onProject: (which: 'new' | { id: string }) => void;
}

/** 行内动作（`data-act`）。拆出来是因为它自己是最大的一块，且完全不需要事件 */
async function runAct(
  act: HTMLElement,
  deps: ClickDeps,
): Promise<void> {
  const { confirm } = deps;
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
        toast(task?.date === D.today()
          ? '已完成 · 收进「今天 › 今天已完成」'
          : '已完成，收进「已完成」');
      }
      return;
    }
    case 'habit':
      store.toggleHabit(id);
      return;
    /* ---- 多选（批量管理，2026-10-14）----
       列表顶部的「选择」进入；进入后整条工具栏换成操作按钮。
       这三个列表（逾期 / 待办箱 / 已完成）共用一套动作，靠 data-selkind
       区分「完成」还是「取消完成」。 */
    case 'sel-start':
      store.selStart();
      return;
    case 'sel-cancel':
      store.selCancel();
      return;
    case 'sel-toggle':
      store.selToggle(id);
      return;
    case 'sel-all': {
      // 全选要「当前列表里所有看得见的」，dispatch 拿不到视图的 list ——
      // 所以由视图把 id 列表放在工具栏上带过来（data-ids，逗号分隔）。
      const ids = (act.dataset.ids || '').split(',').filter(Boolean);
      store.selAll(ids);
      return;
    }
    case 'sel-done':
    case 'sel-undo-done': {
      const ids = store.get().ui.sel || [];
      if (!ids.length) return;
      const done = act.dataset.act === 'sel-done';
      const n = store.batchSetDone(ids, done);
      store.selCancel();
      toast(done ? `已完成 ${n} 项` : `已取消完成 ${n} 项`);
      return;
    }
    case 'sel-del': {
      const ids = store.get().ui.sel || [];
      if (!ids.length) return;
      const ok = await confirm({
        title: `删除选中的 ${ids.length} 项？`,
        body: '会放进「垃圾箱」，在那里还能还原。重复任务只删选中的这几次，重复规则不受影响。',
        confirmText: '删除', danger: true,
      });
      if (!ok) return;
      const n = store.batchDelete(ids, '批量删除');
      store.selCancel();
      toast(`已删除 ${n} 项`, { label: '撤销', run: () => { for (const x of ids) store.restoreTask(x); } });
      return;
    }
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
    /* 项目 / 打卡这两组是**页级**动作（不被拖拽换掉节点），同样走委托，
       和行内动作同一个入口 —— 命中 [data-act] 即到这儿，不用另设通道。 */
    case 'new-project':
      deps.onProject('new');
      return;
    case 'edit-project':
      deps.onProject({ id });
      return;
    case 'add-habit': {
      // 词在同一个 .habit-add 表单里的那个框上（views/Habits.tsx 放的标记）
      const box = act.closest<HTMLElement>('.habit-add')
        ?.querySelector<HTMLInputElement>('[data-add-habit]');
      const v = box?.value.trim();
      if (!v) return;   // 空着不建：别造一个没有名字的打卡项
      store.addHabit(v);
      toast('已添加打卡项：' + v);
      return;
    }
    case 'restore': {
      if (act.dataset.kind === 'habit') store.restoreHabit(id); else store.restoreTask(id);
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

/**
 * `change` 事件的委托 —— **只有输入框用得到它**（当前唯一一处：项目的
 * 「下一步」）。
 *
 * 为什么单开一条：`onClick` 分派的是「按下去」
 * ，而「输入完失焦」不是点击，
 * 挂在 `data-act` 上的输入框等不到 click。`change` 在 input 上的语义正好是
 * 「值改了、且失焦了才发一次」—— 比 keyup 适合落库（每敲一个字发一次会
 * 刷一大串 op），也比 blur 准（值没变不发）。
 *
 * **不复用 React 的 onChange/onBlur**：那是同一个理由 —— 行会被拖拽重排、
 * 同步落地换掉节点，挂在行上的 handler 会跟着丢（见上面那段）。
 * `pickDate.ts` 也是用原生 change 收「改到…」那个离屏日期框。
 */
export function makeOnChange() {
  return function onChange(e: Event): void {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const act = el.closest<HTMLElement>('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'next-project': {
        // 「下一步」：失焦才落库。受控 input 的 DOM value 与 React state 同步，
        // 委托这一头读它的 value 就够 —— 视图不再需要一个 onBlur prop。
        const id = act.dataset.id || '';
        const v = (act as HTMLInputElement).value.trim();
        const cur = store.get().projects[id];
        if (cur && v !== cur.next) store.patchProject(id, { next: v });
        return;
      }
      default:
        return;
    }
  };
}

/** 能开草稿框的区域前缀。改动这张表要连 `views/calendar/` 那几个 `NewCellSlot` 一起动 */
const DRAFT_KINDS = ['timeline', 'allday', 'week', 'day', 'proj'];

/**
 * 点日历上的空格子 → 算出「要开在哪」。**纯计算，不碰 store 也不碰 DOM 状态**。
 *
 * ## 为什么不直接 `addTask` 再开抽屉
 *
 * 这是 2026-10-15 改的写法。老版本是「新建一个空任务 + 立刻弹抽屉」，两个毛病：
 * 第一，**先造了一条垃圾** —— 抽屉一关（或 Esc）那条空任务就留在那儿了，得自己
 * 再删一次；第二，「在哪一天几点」这种本该由**点的位置**说了算的事，被推给了抽屉
 * 里的两个表单字段。现在是反过来：位置决定日期时间，抽屉是**事后再补给细节**的
 * 地方（加详细内容、设重复），不再承担「确定时空坐标」。
 *
 * ## 位置为什么从快照里取
 *
 * `click` 时读 `getBoundingClientRect()` 会读到**此刻**的布局。但从手指按下到
 * click 之间，键盘可能正好收起、页面高度变了一倍 —— 那时 `e.clientY`（按下那一刻
 * 的坐标）配上新的 rect，能把 21:00 算成 7:00（实测偏 14 小时）。
 * `tapSnap` 在 pointerdown 就把分钟算完，这里只取结果。
 *
 * ## 四种区域前缀的来历
 *
 * zone id 本来是给 dnd 用的（`useDroppableZone`），这里**复用同一套名字** ——
 * 拖拽落下与点击开框认的是同一个「这是哪一块」的答案，两边各起一套名字迟早漂。
 * 前缀同时也表达了「这一区带不带时间」：带时间的两区要拿 pointer 的纵坐标换算，
 * 不带时间的两区有日期就够了。
 */
function draftSeedFrom(
  zone: HTMLElement,
  e: { clientX: number; clientY: number; target: EventTarget | null },
): DraftSeed | null {
  const zid = zone.dataset.zoneId || '';
  const kind = zid.slice(0, zid.indexOf(':'));
  /* `data-zone-id` 不是日历专用的：项目泳道的每一列（`proj:<id>:<column>`）
     也用它做拖放的落点。点到那里不该开出个草稿框 —— 那儿的 columns 既不是日期
     也不是时刻。所以按前缀白名单过滤，而不是「有 data-zone-id 就算」。 */
  if (!DRAFT_KINDS.includes(kind)) return null;

  const date = zone.dataset.date || store.get().ui.cursor;
  let time: string | null = null;

  if (kind === 'proj') {
    /* 项目泳道列：点列体空白处就地新建（用户 2026-10-17 —— 项目页也只留
       这一个新建入口，顶部横条已隐藏）。三条规矩：
       · 只认**列体**（.pj-col-b）：列头点的是列名/计数，不开草稿；
       · 只开待办 / 进行中两列：新建的任务不可能是已完成；
       · 日期留空：泳道里的卡片是待办性质的，没有「这一天」。 */
    if (!(e.target as HTMLElement | null)?.closest?.('.pj-col-b')) return null;
    const m = /^proj:([^:]+):(todo|doing)$/.exec(zid);
    if (!m) return null;
    return {
      zone: zid, date: null, time: null,
      projectId: m[1], doing: m[2] === 'doing',
    };
  }

  if (kind === 'timeline') {
    /* 优先用 pressed 那一刻的快照（同坐标系），取不到才现场算。
       日视图时间轴高度是算出来的（锁定单屏），不能拿 DAY_H 当分母。 */
    const tap = takeTap(e.clientX, e.clientY, zone);
    if (tap) {
      time = D.minToTime(tap.min);
    } else {
      const r = zone.getBoundingClientRect();
      time = D.minToTime(yToMin(e.clientY - r.top, r.height, domWindow(zone)));
    }
  } else if (kind === 'week') {
    const tap = takeTap(e.clientX, e.clientY, zone);
    const min = tap
      ? tap.min
      : Math.max(0, Math.min(1425, Math.round(((e.clientY - zone.getBoundingClientRect().top) / DAY_H) * 1440 / 15) * 15));
    time = D.minToTime(min);
  }
  // 'allday'（全天区）与 'day'（月视图格子）不带时间 —— 只落在那一天

  /* 手机 + **日视图时间轴**才吸附到整点（用户 2026-10-17）。
     · 手机上格子比手指还细，按位置算出来常是 9:07、14:23，用户想的是「9 点」；
     · 网页端格子大、瞄得准，15 分钟一档才够用，硬吸整点反而丢精度；
     · 周视图一列只有几十像素宽、也不适用，保持 15 分钟。 */
  if (time && kind === 'timeline' && isNarrowNow()) {
    const m = D.timeToMin(time);
    if (m !== null) time = D.minToTime(snapToHour(m));
  }

  return { zone: zid, date, time };
}

export function makeOnClick(deps: ClickDeps) {
  return async function onClick(e: React.MouseEvent): Promise<void> {
    const el = e.target as HTMLElement;

    /* 点的是就地新建框自己 → 什么都不做。它自己处理回车 / Esc，
       而且 `data-act="draft"` 会让下面的分派把它当成「又点了一次空白」。 */
    if (el.closest('.new-cell')) return;

    /* 这一下最终有没有开出新草稿。**必须在所有分支跑完之后统一结算**：
       见 finally —— 先把新草稿算好，再一次替换掉旧的，中间不留「已卸载」
       的空档。否则卸载 → 键盘收起 → 布局变高，正是 21:00 算成 7:00 的成因。 */
    let seed: DraftSeed | null = null;

    try {
      // 1) 行内动作
      const act = el.closest<HTMLElement>('[data-act]');
      if (act) {
        e.stopPropagation();
        await runAct(act, deps);
        return;
      }

    // 2) 跳转 / 找日期 / 打卡管理
    const jump = el.closest<HTMLElement>('[data-jump]');
    if (jump?.dataset.jump) {
      // 跳转顺带清空搜索：不然跳过去只看得见过滤剩下的几条，像是那天没内容
      store.setUi({ nav: 'calendar', view: 'day', cursor: jump.dataset.jump, search: '' });
      return;
    }
    const navBtn = el.closest<HTMLElement>('[data-nav]');
    if (navBtn?.dataset.nav) { deps.nav(navBtn.dataset.nav); return; }
    if (el.closest('[data-jump-habits]')) { deps.nav('habits'); return; }

    /* 2.5) 多选态下点行 = 切换选中，**不开抽屉**（2026-10-14）。
       必须排在「点行开抽屉」前面 —— 否则用户一多选就被抽屉挡住，
       那正是「批量管理」最别扭的地方。 */
    /* 判据是「这一行**确实渲染了选择圈**」（data-sel 存在），不是「ui.sel 非空」。
       多选只在逾期/待办箱/已完成渲染；万一状态没清干净带到了别的页，
       这里也不会把那些页的行点击吞掉 —— 它们根本没这个属性。 */
    if (store.get().ui.sel !== null) {
      const selRow = el.closest<HTMLElement>('.task-el');
      if (selRow?.dataset.id && selRow.dataset.sel !== undefined) {
        store.selToggle(selRow.dataset.id);
        return;
      }
    }

    // 3) 点行 = 开抽屉。放在这一层，前面任何一个命中都不该再开抽屉
    const row = el.closest<HTMLElement>('.task-el');
    if (row?.dataset.id && !row.classList.contains('habit-row')) { deps.setOpenId(row.dataset.id); return; }
    // 打卡条上的条目点标题不做任何事（点勾是打卡，长按改期）

    /* 4) 点日历里的空格子 → 就地开一个输入框。
       这一层必须排在第 3 步之后**：任务卡片本身就长在这些区域里（`.task-el`），
       顺序反了会把「点开某条任务」变成「又开一个草稿框」。 */
    const zone = el.closest<HTMLElement>('[data-zone-id]');
    if (zone) seed = draftSeedFrom(zone, e);
    } finally {
      /* 所有分支的统一收尾：结算上一条草稿（有字落库、没字丢弃），
         再一次性换成这一下算出来的新草稿（null = 只结算、不开新的）。
         ⚠️ 不做「先 setUi(null) 再 setUi(新)」两步 —— 那会让输入框先卸载，
            键盘跟着收起、布局变高，于是又落回坐标错配里（21:00 → 7:00）。 */
      settleDraftAndSet(seed);
    }
  };
}