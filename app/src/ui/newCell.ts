/**
 * newCell.ts —— 就地新建草稿的写库入口（收进 ui/，views 不碰 data/store）。
 */
import * as store from '../data/store.ts';
import type { DraftSeed } from '../domain/types.ts';

export function commitDraftTask(title: string, seed: DraftSeed): string {
  const id = store.addTask({ title, date: seed.date, time: seed.time, duration: seed.duration ?? null });
  /* 泳道列里点的草稿：落成即归项目、按列定 doing。一次 patch 带过去，
     不拆成 addTask + setTaskProject 两笔提交。 */
  if (seed.projectId) {
    store.patchTask(id, { projectId: seed.projectId, doing: seed.doing ?? false });
  }
  return id;
}

export function setDraftNull(): void {
  store.setUi({ draft: null });
}

/* ---------------------------------------------------------------- 回声保护
 *
 * **手指点中的那个节点，被「开草稿」这次渲染顺手换掉了。**
 *
 * 2026-10-22 真机 + 桌面深测一起抓到的：点未定时区末尾那格空白 →
 * 派发器算好 seed、草稿真的开出来了（`settle` 收到 `allday:…`），
 * **3ms 之后又被清成 null**。清它的不是派发器，是 Workbench 里挂在
 * `document` 上那条兜底收尾（点 `#content` 之外才收草稿）。
 *
 * 为什么会「点在 #content 外面」：新草稿占掉一个孔位，`.allday-blank`
 * 那一格被 React 卸掉了；浏览器发现触发起点的节点已经不在文档里，
 * 就把这一次 click 补发给最近的祖先（body）。对兜底那条来说，这跟
 * 「用户点了侧栏」长得一模一样 —— 于是刚开出来的草稿被自己那一下关掉。
 * 症状就是用户报的「点加号/点空白没有任何反应」（草稿开了又秒关，
 * 一帧都看不见）。
 *
 * 所以记下「刚刚开过草稿」的时刻，兜底那条见到它就跳过这一下。
 * ⚠️ 别把这个判断改成「看 target 是不是 body」：补发的目标不一定是 body，
 *    换一次浏览器/DOM 结构就变。时间窗才是稳定的那道闸。
 */
let openedAt = 0;

/** 这一下点击是不是「刚开出来的草稿的回声」。默认 450ms 内都算 */
export function draftEcho(ms = 450): boolean {
  return openedAt > 0 && Date.now() - openedAt < ms;
}

/**
 * 结算上一条草稿，并把下一条（可以是 null）**一次性**换上。
 *
 * 为什么是一次：`setUi` 里是浅合并 + 同步 emit。分成「先清空、再设新的」两步，
 * React 会在两步之间把输入框卸掉 —— 键盘跟着收起、页面高度变回来，
 * 于是紧接着算落的点就落到了另一个坐标系里（实测 21:00 会落成 7:00）。
 * 合成一次状态更新，中间就没有这个空档。
 *
 * 有字就落成任务（用户 2026-10-17 确认：点别处时已经打的字不用再按回车），
 * 没字就丢掉。
 */
export function settleDraftAndSet(next: DraftSeed | null): void {
  const cur = store.get().ui.draft;
  if (!cur && !next) return;              // 本来就没草稿、也不开新的 → 别白 emit

  if (cur) {
    const el = document.querySelector<HTMLTextAreaElement>('.new-cell');
    const v = (el?.value ?? '').trim();
    if (v) commitDraftTask(v, cur);
  }
  if (next) openedAt = Date.now();        // 见上面「回声保护」
  /* 传新对象（不是同一个引用）：NewCell 靠 seed 的引用变化来清空上一处残留的字 */
  store.setUi({ draft: next ? { ...next } : null });
}
