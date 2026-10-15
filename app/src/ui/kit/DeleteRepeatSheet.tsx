/**
 * DeleteRepeatSheet —— 删除重复任务时的「删哪些」选择（2026-10-14）
 *
 * 用户原话：「当我删除某一个重复的任务的时候，应该弹出来一个弹框问我是
 * 删当天这个任务，还是删除日后所有的重复任务」。
 *
 * 为什么不用现成的 {@link Confirm}：它是「确定 / 取消」二元返回 boolean，
 * 这里要三选（只删这次 / 从这次起全部 / 取消），语义装不下 ——
 * 硬塞进去只能把两个「删」做成标题+按钮，很别扭。
 *
 * 语义（已与用户确认）：
 *   · **只删这一次** → 删掉这条，系列规则保留，明天的下一次照常出现
 *   · **从这次起全部** → 结束这个系列，这天及以后都不再出现；
 *     这天之前已完成的历史保留
 */

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet.tsx';
import { Btn } from './Btn.tsx';
import { relLabel } from '../../domain/date.ts';

/** 'one' = 只删这一次；'series' = 从这次起往后全部；'cancel' = 不删 */
export type DeleteRepeatChoice = 'one' | 'series' | 'cancel';

interface Props {
  open: boolean;
  /** 任务标题，用于弹框文案 */
  title: string;
  /** 这次的发生日 yyyy-MM-dd */
  date: string | null;
  onChoose: (c: DeleteRepeatChoice) => void;
}

export function DeleteRepeatSheet({ open, title, date, onChoose }: Props) {
  const [show, setShow] = useState(false);
  // 打开那一刻把 date 存下来：用户在浮层里翻日历时不能影响已经弹出的这次
  const [snapDate, setSnapDate] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setSnapDate(date); setShow(true); }
    else setShow(false);
  }, [open, date]);

  const when = snapDate ? relLabel(snapDate) : '这一天';

  return (
    <Sheet
      open={show}
      onClose={() => onChoose('cancel')}
      title="这是重复任务"
      dismissable={false}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onChoose('cancel')}>取消</Btn>
          <Btn variant="danger" onClick={() => onChoose('series')}>
            从这次起全部
          </Btn>
        </>
      }
    >
      <div className="space-y-3 text-[13px] leading-relaxed text-[var(--text-2)]">
        <p>
          「{title}」是重复任务（{when}）。要删掉哪些？
        </p>
        <div className="space-y-2 pt-1">
          <ChoiceRow
            title="只删这一次"
            hint="保留重复规则，明天的下一次照常出现"
            onClick={() => onChoose('one')}
          />
          <ChoiceRow
            title="从这次起往后全部"
            hint={`${when}及之后都不再出现；之前已完成的保留`}
            onClick={() => onChoose('series')}
          />
        </div>
        <p className="pt-1 text-[11px] text-[var(--text-3)]">
          删除的任务可以在「回收站」里找回。
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
