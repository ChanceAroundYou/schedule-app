/**
 * SelBar.tsx —— 列表顶部的「选择」工具栏（2026-10-14）
 *
 * 用户要求：逾期 / 待办箱 / 已完成 三个列表要有批量管理（批量完成、批量删除）。
 *
 * **为什么是顶部按钮而不是长按进入**：触屏上「按住 250ms」已经被拖拽排序
 * 占用了（dnd-kit 的 TouchSensor delay），而且这四个列表都开着拖拽。
 * 同一个手势不能既拖拽又进多选 —— 硬凑的话拖拽浮层会先抬起来再弹多选。
 * 顶部放一个按钮零手势冲突，也更容易被发现（iOS 邮件那种「编辑」）。
 *
 * 查看态出「选择」，多选态整条换成「已选 N 项 + 全选 + 操作 + 取消」。
 * 纯展示、零回调 —— 全部走 data-act，由 clickDispatch 分派。
 */

/** 多选作用的列表类型。工具栏按它决定文案（完成 / 取消完成） */
export type SelKind = 'overdue' | 'inbox' | 'done';

interface Props {
  kind: SelKind;
  /** null = 没在多选 */
  sel: string[] | null;
  /** 当前列表里所有可选条目 id，供「全选」用 */
  ids: string[];
  /** 空列表时不渲染（没什么可选的） */
  hidden?: boolean;
}

export function SelBar({ kind, sel, ids, hidden }: Props) {
  if (hidden) return null;

  if (sel === null) {
    return (
      <div className="sel-bar">
        <button type="button" className="sel-btn" data-act="sel-start">
          选择
        </button>
      </div>
    );
  }

  const n = sel.length;
  const allOn = n > 0 && n >= ids.length;

  return (
    <div className="sel-bar on">
      <span className="sel-count">已选 {n} 项</span>
      <span className="sel-actions">
        {/* data-ids 带上当前列表的全部 id —— dispatch 拿不到视图的 list，
            「全选」只能由视图把范围捎过去 */}
        <button
          type="button" className="sel-btn" data-act="sel-all"
          data-ids={ids.join(',')}
          disabled={!ids.length}
        >
          {allOn ? '全不选' : '全选'}
        </button>
        {kind === 'done' ? (
          <button type="button" className="sel-btn" data-act="sel-undo-done" disabled={!n}>
            取消完成
          </button>
        ) : (
          <button type="button" className="sel-btn primary" data-act="sel-done" disabled={!n}>
            完成
          </button>
        )}
        <button type="button" className="sel-btn danger" data-act="sel-del" disabled={!n}>
          删除
        </button>
        <button type="button" className="sel-btn" data-act="sel-cancel">取消</button>
      </span>
    </div>
  );
}
