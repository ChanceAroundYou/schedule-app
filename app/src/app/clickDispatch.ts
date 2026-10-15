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
 *   4. `[data-drop]`  点日历空白 = 新建并直接打开抽屉
 *
 * 第 4 步**必须排在第 3 步之后**：任务方块本身就长在落点区域里，顺序反了会把
 * 「点开某条任务」变成「新建一条空任务」，而且这条空任务还排在它前面。
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
import { pickDate } from './pickDate.ts';
import { DAY_H, yToMin } from '../domain/layout.ts';

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

/** 点日历空白 → 新建一条并直接打开抽屉。四种区域含义不同，不能统一处理 */
function dropZone(zone: HTMLElement, e: React.MouseEvent, setOpenId: (id: string | null) => void): void {
  const kind = zone.dataset.drop;
  const date = zone.dataset.date || store.get().ui.cursor;

  if (kind === 'day' || kind === 'allday') {
    // 全天区与月视图格子只给日期不给时间
    setOpenId(store.addTask({ title: '', date, time: null }));
    return;
  }
  if (kind === 'timeline' || kind === 'week') {
    const r = zone.getBoundingClientRect();
    /* 时间轴高度是算出来的（锁定单屏），不能拿 DAY_H 当分母 ——
       实测高度 + 窗内换算，见 domain/layout.ts 的 yToMin。
       周视图是固定 DAY_H，才用那一套公式。 */
    const min = kind === 'timeline'
      ? yToMin(e.clientY - r.top, r.height, domWindow(zone))
      : Math.max(0, Math.min(1425, Math.round(((e.clientY - r.top) / DAY_H) * 1440 / 15) * 15));
    setOpenId(store.addTask({ title: '', date, time: D.minToTime(min) }));
  }
}

export function makeOnClick(deps: ClickDeps) {
  return async function onClick(e: React.MouseEvent): Promise<void> {
    const el = e.target as HTMLElement;

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

    // 4) 点日历空白
    const zone = el.closest<HTMLElement>('[data-drop]');
    if (zone) dropZone(zone, e, deps.setOpenId);
  };
}