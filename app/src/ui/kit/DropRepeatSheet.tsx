/**
 * DropRepeatSheet —— 把重复任务改成「不重复」时的处置选择（2026-10-17）
 *
 * 用户原话：「当我已经设置了一个重复任务…修改它的重复类型为不重复之后，
 * 这个日程表上已经纳入日程范围的重复任务并没有随之消失…我希望达到的效果是，
 * 当用户把已经设置为重复的任务更改为不重复之后，你应该弹出一个对话框，
 * 询问客户之前已经放在日程表上的重复任务是否需要继续保留或者删除。」
 *
 * 语义（已与用户确认）：
 *   · **保留** → 已经排进日程的那些变成一条条**独立任务**留在原处，只是不再重复
 *   · **删除** → 只留这一次 + 过去的历史；其余进回收站（可找回）
 *   · 取消 → 什么都不改（连重复也还没取消）
 *
 * 为什么不用 `Confirm`：它是 boolean 二元，这里要「保留 / 删除 / 取消」三选，
 * 和 DeleteRepeatSheet 是同类问题，样式也保持一致。
 */

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet.tsx';
import { Btn } from './Btn.tsx';

export type DropRepeatChoice = 'keep' | 'delete' | 'cancel';

interface Props {
  open: boolean;
  /** 任务标题 */
  title: string;
  /** 还有多少次未发生的实例 */
  count: number;
  /** 最早 / 最晚那次的日期（yyyy-MM-dd），用于把范围说清楚 */
  first: string | null;
  last: string | null;
  onChoose: (c: DropRepeatChoice) => void;
}

export function DropRepeatSheet({ open, title, count, first, last, onChoose }: Props) {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(open); }, [open]);

  const range = first && last
    ? (first === last ? `（${first}）` : `（${first} 到 ${last}）`)
    : '';

  return (
    <Sheet
      open={show}
      onClose={() => onChoose('cancel')}
      title="取消重复"
      dismissable={false}
      footer={<Btn variant="ghost" onClick={() => onChoose('cancel')}>取消</Btn>}
    >
      <div className="space-y-3 text-[13px] leading-relaxed text-[var(--text-2)]">
        <p>
          「{title}」原来是重复任务，日程表上还有 <b className="text-[var(--text)]">{count}</b> 次
          没有发生{range}。这次取消重复之后，这些已经排好的要怎么处理？
        </p>
        <div className="space-y-2 pt-1">
          <ChoiceRow
            title="保留这些任务"
            hint="它们变成独立的普通任务，留在日程上；只是以后不再重复"
            onClick={() => onChoose('keep')}
          />
          <ChoiceRow
            title="删除这些任务"
            hint="只保留这一次和已经过去的历史；删掉的可以在「回收站」找回"
            onClick={() => onChoose('delete')}
          />
        </div>
        <p className="pt-1 text-[11px] text-[var(--text-3)]">
          这条任务本身不会被删除，只是不再重复。
        </p>
      </div>
    </Sheet>
  );
}

function ChoiceRow({ title, hint, onClick }: {
  title: string; hint: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--panel)]
                 px-3 py-2.5 text-left active:bg-[var(--panel-2)]"
    >
      <div className="text-[13px] font-medium text-[var(--text)]">{title}</div>
      <div className="mt-0.5 text-[11px] text-[var(--text-3)]">{hint}</div>
    </button>
  );
}
