/**
 * Drawer.tsx —— 任务详情 / 编辑抽屉
 *
 * 交互统一是「列表 → 详情 → 编辑」三段式（用户 2026-10-05 裁决）：
 * 点行开抽屉看详情，改字段就地改、失焦即存。这里**没有**独立的编辑页。
 *
 * `confirm()` 一律不用 —— 原生 confirm 在 PWA 里会被静默吞掉，用户点删除
 * 完全没反应。走 useConfirm()（在 useDrawer.ts 里）。
 *
 * **底部没有按钮**（2026-10-09 精简）：每个字段都是就地改、失焦即存，
 * 「完成」只是关掉抽屉 —— 用标题栏那个打勾。删除也上移到标题栏。
 * 底部那排按钮唯一的用处是让人确认「我改完了」，可改完本来就不用确认。
 *
 * 日期和时间用自定义控件（DatePicker / TimePicker），不用原生 input，
 * **也没有「今天 / 明天」「12 点」这类快捷格**。时间选两次：开始、结束 ——
 * 结束时间设了就是一条持续任务，没设就是默认的一小时。
 *
 * 重复设置收在字段旁的复合浮层里，不再摊成一片 chips + 面板。
 *
 * 拆分（桶文件，import 路径不变）：
 *   useDrawer.ts      状态 + 四处 effect + 删除确认
 *   DrawerFields.tsx  字段行（日期时间 / 日程集项目 / 重复按钮 / 详细内容 / 元信息）
 *   RepeatPop.tsx     重复复合浮层
 */

import { Check, Trash2 } from 'lucide-react';
import type { LocalState, Task } from '../../domain/types.ts';
import { repeatLabel, toRepeat } from '../../domain/repeat.ts';
import { IconBtn, Input } from '../kit.tsx';
import { ConflictBox } from './ConflictBox.tsx';
import { useDrawer } from './useDrawer.ts';
import { CalProjRow, DateTimeRow, NoteRow, ReminderRow } from './DrawerFields.tsx';
import { RepeatPop } from './RepeatPop.tsx';

export function Drawer({ state, id, onClose, onPatch, onMoveToCal, onToggle, onDelete, onDismissConflict }: {
  state: LocalState;
  id: string | null;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<Task>) => void;
  onMoveToCal: (id: string, calId: string) => void;
  /**
   * 勾选完成。**必须走 `store.toggleTask()`，不能自己 patch `done`。**
   *
   * 差别只在重复任务上：勾完一条「每天」的任务，要由 toggleTask 派生出下一个
   * 实例，否则下一次永远不会出现 —— 这条曾经在抽屉里被写成 `onPatch({done})`，
   * 于是「在抽屉里勾掉重复任务 = 这个系列到此为止」，而且没有任何提示。
   */
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onDismissConflict: (entityId: string, field: string) => void;
}) {
  const s = useDrawer({ state, id, onClose, onPatch, onToggle, onDelete });
  if (!s.task) return null;

  const { task, patch, repPatch, repOpen, setRepOpen, repAnchor, repPos, osbBody, osbRep, fid } = s;
  const rep = task.repeat;
  const repLabel = rep.unit === 'none' ? '不重复' : repeatLabel(rep);

  return (
    <>
      {/* 遮罩是纯鼠标目标（键盘走 Escape），对读屏没有意义，别让它念出一个空 div */}
      <div className="mask show" aria-hidden="true" onClick={onClose} />
      <aside
        className="drawer open"
        ref={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label={'任务详情：' + task.title}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <label className="check-wrap">
            <input
              type="checkbox"
              checked={!!task.done}
              /* 包着它的 <label> 里一个字都没有，所以它自己没有名字 ——
                 名字只能从这儿给。措辞和 parts.tsx 的 <CheckBtn> 对齐。 */
              aria-label={task.done ? '取消完成' : '标记完成'}
              onChange={s.toggleDone}
            />
            <span className="check-circle" />
          </label>
          <Input
            type="text"
            className="drawer-title"
            placeholder="任务名称"
            aria-label="任务名称"
            value={s.title}
            onChange={(e) => s.setTitle(e.target.value)}
            onBlur={() => { const v = s.title.trim() || '未命名任务'; s.setTitle(v); if (v !== task.title) patch({ title: v }); }}
          />
          {/* 标题栏右边两个图标：删除、完成。**底部那排按钮整个删了** ——
              字段都是就地改、失焦即存，「完成」只是关掉抽屉。 */}
          <IconBtn label="删除任务" className="icon-btn" onClick={() => void s.remove()}>
            <Trash2 size={15} />
          </IconBtn>
          <IconBtn label="完成" className="icon-btn" onClick={onClose}>
            <Check size={16} />
          </IconBtn>
        </div>

        <div className="drawer-body osb" ref={osbBody}>
          <ConflictBox
            list={state.conflicts.filter((c) => c.entityId === task.id)}
            onDismiss={(field: string) => onDismissConflict(task.id, field)}
          />

          {/* 项目归属**只在这一处改**，拖拽不改它。
              拖进泳道列只换「哪一列」，搬归属是这条下拉的职责 ——
              拖动顺手把「搬家」也做掉，比什么都不做更让人措手不及。 */}
          <DateTimeRow task={task} endTime={s.endTime} onPatch={onPatch} setEnd={s.setEnd} />
          <CalProjRow
            task={task}
            fid={fid}
            calOptions={s.calOptions}
            projs={s.projs}
            onPatch={onPatch}
            onMoveToCal={onMoveToCal}
          />

          <div className="field">
            <span className="flabel" id={fid + '-rep-l'}>重复</span>
            {/* 一个按钮开一个浮层。原先是 chips + 一整个面板摊在抽屉里 ——
                展开之后比「项目」和「详细内容」加起来还长。 */}
            <button
              ref={repAnchor}
              type="button"
              className={'rep-open' + (rep.unit !== 'none' ? ' on' : '')}
              aria-labelledby={fid + '-rep-l'}
              onClick={() => setRepOpen(true)}
            >
              <span className="rep-label">{repLabel}</span>
              {rep.unit !== 'none' && (
                <span
                  className="rep-x"
                  aria-label="清除重复"
                  onClick={(e) => {
                    e.stopPropagation();
                    repPatch(toRepeat({ unit: 'none', n: 1, end: null }, task.date));
                    setRepOpen(false);
                  }}
                >✕</span>
              )}
            </button>
          </div>

          <NoteRow fid={fid} note={s.note} onPatch={(v) => { if (v !== (task.note || '')) patch({ note: v }); }} />

          {/* 提醒：与小组件同一个字段（reminder = "HH:mm"） */}
          <ReminderRow task={task} onPatch={onPatch} />
        </div>
      </aside>

      {/* 重复设置的复合浮层。**左上角不再写「重复」**（2026-10-11）——
          它是从抽屉里那个「重复」按钮弹出来的，按钮上的字就是它的名字，
          面板里再写一遍只是占一行高度。关掉走点外面 / Escape。 */}
      {repOpen && (
        <div
          ref={osbRep}
          className="repeat-pop osb"
          role="dialog"
          aria-label="重复"
          style={{ top: repPos ? repPos.top : 0, left: repPos ? repPos.left : 0, visibility: repPos ? 'visible' : 'hidden' }}
        >
          <RepeatPop rep={rep} patch={repPatch} next={s.nextOcc} last={s.lastOcc} />
        </div>
      )}
    </>
  );
}
