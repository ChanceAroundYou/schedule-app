/**
 * useDrawer.ts —— 抽屉的状态与副作用（与展示解耦的那一层）
 *
 * 抽屉本体 492 行，一半是状态和四处 effect。视图那半边按项目规矩
 * （views/ 零回调、`App.tsx` 是唯一知道全部状态的地方）要的是
 * `task` + `patch` + 几个开关 —— 都在这儿备齐。
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { LocalState, RepeatRule, Task } from '../../domain/types.ts';
import { canWrite } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { repeatLast, repeatNext } from '../../domain/repeat.ts';
import { liveProjects } from '../../domain/model.ts';
import { useConfirm } from '../kit.tsx';
import { useAnchoredPosition, useEscape, useFocusTrap, useIsNarrow, useModalFocus, useOutsideClose } from '../hooks.ts';
import { useOverlayScrollbar } from '../scroll.ts';

/** 抽屉 props 里与状态有关的那一小半 —— 状态这一层只用它，不碰渲染。 */
export type DrawerStateProps = {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  /** 勾选完成。**必须走 `store.toggleTask()`，不能自己 patch `done`** —— 见 Drawer.tsx */
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
};

/** useDrawer 交出来的东西：状态 + 由状态算出来的那几个 option / 回调 */
export type DrawerState = ReturnType<typeof useDrawer>;

/**
 * `task` 为 null（没开抽屉 / 那任务没了）时**各字段是空的**，
 * 调用方据此 `if (!task) return null` —— hook 自己不提前返回，
 * 免得哪天有人在中间加一个 hook 就把顺序搞乱。
 */
export function useDrawer({ state, id, onClose, onPatch, onToggle, onDelete }: DrawerStateProps) {
  const confirm = useConfirm();
  const task = id ? state.tasks[id] : null;
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, !!task);
  /* 开时把焦点送进**面板本身**（不是第一个输入框 —— 送进去会当场弹手机软键盘），
     关时还回原来那一行。三个模态浮层共用这一份，见 ui/hooks/modalFocus.ts。 */
  useModalFocus(panel, !!id);

  /** 每个字段的 label / 控件配对用的 id 前缀。
   *  `.field label` 是**兄弟**关系且没有 htmlFor —— 点 label 不会聚焦控件，
   *  读屏也念不出这个框是干什么的。用 useId 配上，别写死字符串（同页面
   *  万一渲染两份就撞了）。见 docs/界面规则.md「六、无障碍」。 */
  const fid = useId();

  // 标题是本地草稿：每敲一个字都写库会让输入框在重渲染里跳光标（旧版踩过）
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [repOpen, setRepOpen] = useState(false);
  const repAnchor = useRef<HTMLButtonElement>(null);
  const repPanel = useRef<HTMLDivElement>(null);
  /* 浮条：抽屉正文和「重复」面板都会滚 —— 见 ui/scroll.ts */
  const osbBody = useOverlayScrollbar<HTMLDivElement>();
  const osbRep = useOverlayScrollbar<HTMLDivElement>(repPanel);
  const lastId = useRef<string | null>(null);

  /**
   * 结束时间**直接从 task 派生**，不是本地 state。
   *
   * 原先它是本地 state：用户改 TimePicker 时 setEnd 顺手 set 一下。但拖卡片
   * 上下沿（resizeTimeline.ts）会直接 patch `duration` 到 store，那条路**不经过**
   * setEnd —— 于是抽屉里的结束时间停在旧值，用户报「调整了结束时间，再进编辑
   * 弹窗又消失了」（2026-10-12）。改成派生之后，三条写 duration 的路
   * （TimePicker / 拖上沿下沿 / QuickAdd 带时长）都指向同一份真相，
   * 没有「哪条路忘了同步」这一说了。
   */
  const endTime = (() => {
    if (!task || !task.time || task.duration == null) return null;
    const start = D.timeToMin(task.time);
    if (start == null) return null;
    const end = start + task.duration;
    return end > 1440 ? D.minToTime(end % 1440) : D.minToTime(end);
  })();

  useEffect(() => {
    if (!task) return;
    if (lastId.current === task.id) return;   // 同一任务的重渲染不要覆盖正在输入的内容
    lastId.current = task.id;
    setTitle(task.title);
    setNote(task.note || '');
  }, [task]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  /* 重复面板自己的 Esc 要**截断**：不截的话抽屉那条也跑了，一点 Escape 连抽屉
     带面板一起关，用户想留抽屉只收面板时做不到。
     截断了才轮不到抽屉那条 —— 顺序正好反过来。 */
  const repClose = () => setRepOpen(false);
  useOutsideClose(repPanel, repOpen, repClose, repAnchor);
  useEscape(repOpen, repClose);
  const repPos = useAnchoredPosition(repAnchor, repPanel, repOpen,
    [task?.repeat.unit, task?.repeat.n, task?.repeat.end?.type], useIsNarrow());

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  const patch = task ? (fields: Partial<Task>) => onPatch(task.id, fields) : () => {};
  /** 合并写当前这份重复规则：`repPatch({n})` = `patch({repeat: {...rep, n}})`。
   *  重复面板里十几次这种调用，每处都手写一遍展开迟早漏一次 `...rep`。 */
  const repPatch = (fields: Partial<RepeatRule>) => {
    if (task) onPatch(task.id, { repeat: { ...task.repeat, ...fields } });
  };

  const remove = async () => {
    if (!task) return;
    /* 重复任务**不走这里的确认框**（2026-10-14）。
       它要问的是「删这一次还是删往后全部」，那是 onDelete 里那个三选浮层的事 ——
       两处各问一次会变成「确认删除？」→ 点删除 → 又弹「要删哪些？」，很蠢。
       这里直接交出去，整个决策由 onDelete 一处负责。 */
    if (task.repeat && task.repeat.unit !== 'none') {
      onDelete(task.id);
      onClose();
      return;
    }
    const ok = await confirm({
      title: '删除这个任务？',
      body: `「${task.title}」会移到垃圾箱，可以还原。`,
      confirmText: '删除',
      danger: true,
    });
    if (ok) { onDelete(task.id); onClose(); }
  };

  const toggleDone = () => { if (task) onToggle(task.id); };

  /**
   * 下一次 / 最后一次落在哪天。**实时算给用户看** —— 重复规则是「每周三 +
   * 隔 2 周 + 到某天为止」这种组合，光看几个下拉框想象不出结果。
   * `lastOcc` 在「不结束」时为 null（没有最后一次）。
   */
  const nextOcc = task && task.repeat.unit !== 'none'
    ? repeatNext(task, task.date || D.today())
    : null;
  const lastOcc = task && task.repeat.unit !== 'none'
    ? repeatLast(task, task.date || D.today())
    : null;

  const startMin = task ? D.timeToMin(task.time) : null;
  /** 改结束时间 = 改 duration。endTime 是派生的，这里只写 store。
   *  `v == null` 表示清空结束时间 → duration 设为 null（不是默认 60）。 */
  const setEnd = (v: string | null) => {
    const s = startMin;
    if (v == null || s == null) { patch({ duration: null }); return; }
    const e = D.timeToMin(v);
    if (e == null) { patch({ duration: null }); return; }
    patch({ duration: e > s ? e - s : e - s + 1440 });
  };

  return {
    task, title, setTitle, note, setNote, endTime, setEnd,
    repOpen, setRepOpen, repAnchor, repPanel, osbBody, osbRep, repPos, fid,
    panel, nextOcc, lastOcc, patch, repPatch, remove, toggleDone,
    /* 归属跨集选不了：项目是**按集**的（跟日程 / 打卡 / 已完成一样）——
       挂到别的集的项目上，那条泳道在那边会凭空多出一张卡。 */
    projs: task ? liveProjects(state) : [],
    calOptions: task
      ? state.cals.filter((c) => canWrite(c.role)).map((c) => ({ value: c.id, label: c.name }))
      : [],
  };
}
