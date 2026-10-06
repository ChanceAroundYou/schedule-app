/**
 * dragState.ts —— 「正在拖动」这个瞬时标志
 *
 * 存在的唯一理由是给同步引擎看的：拖动过程中一旦发生重渲染，React 会把
 * 让位用的 transform 和占位洞全部重建掉，用户看到的是「拖到一半整个列表
 * 弹回原位」。
 *
 * 拖动期间几乎不可能有远端变更，但也几乎 —— 轮询恰好在这几秒落地就会撞上。
 * 与其去防各种重渲染路径，不如让引擎在拖动时干脆别拉。
 *
 * 单独一个模块是为了避开循环依赖：dnd.ts 与 sync/engine.ts 都要用它，
 * 而 engine 不应该认识 UI。
 */

let dragging = false;

export function setDragging(v: boolean): void { dragging = v; }
export function isDragging(): boolean { return dragging; }
