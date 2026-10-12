/**
 * FastSide.tsx —— 快速添加横条右侧的竖排按钮组（时钟 + 保存）
 *
 * 从 `QuickAdd.tsx` 拆出来。这一段自己有一套道具：`clockBtn` ref（锚点）、
 * 生效的日期/时间（画在按钮上）、`submit` 回调。它跟 QuickAdd 的状态机
 * （closing / expanded / outside-close 三级）没有关系 —— 拆出去之后 QuickAdd
 * 主体只剩那一台状态机。
 */

import { Check, Clock } from 'lucide-react';
import * as D from '../../domain/date.ts';

export interface FastSideProps {
  /** 时钟按钮的 ref —— `WhenPop` 拿它当定位锚点 */
  clockBtn: React.Ref<HTMLButtonElement>;
  /** 日期时间面板开没开（时钟按钮上的 `aria-expanded`） */
  whenOpen: boolean;
  /** 生效日期（跟着 tab 来的默认值也算「有」，要画出来） */
  effDate: string | null;
  /** 生效时间，同上 */
  effTime: string | null;
  onToggleWhen: () => void;
  /** 点保存（`false` = 不顺手打开详情） */
  onSave: () => void;
  /** 输入框空着 → 保存禁用 */
  canSave: boolean;
}

export function FastSide({
  clockBtn, whenOpen, effDate, effTime, onToggleWhen, onSave, canSave,
}: FastSideProps) {
  // 跟着 tab 来的默认日期也算「有」—— 按钮上要写出来（需求 6）
  const hasWhen = !!(effDate || effTime);
  return (
    <div className="fast-side">
      <button
        ref={clockBtn}
        className={'fast-clock' + (hasWhen ? ' on' : '')}
        type="button"
        title="选择日期和时间"
        aria-expanded={whenOpen}
        onClick={onToggleWhen}
      >
        <Clock size={15} />
        {/* 选好的日期 / 时间分两行摆在图标右边（需求 1）：上行 10/7、下行 08:00。
            写的都是**生效值** —— 跟着 tab 来的默认日期（今天页 / 日程页）
            也在这儿显示，和面板里写的是同一个值（需求 6）。 */}
        {hasWhen && (
          <span className="fc-when">
            {effDate && <span className="fc-d">{D.fmtSlashMD(effDate)}</span>}
            {effTime && <span className="fc-t">{effTime}</span>}
          </span>
        )}
      </button>
      {/* 「保存」是个 ✓（需求 3）。一行里三个文字按钮太吵，保存这件事有个勾就够了。 */}
      <button
        className="fast-save"
        type="button"
        disabled={!canSave}
        title="保存这条任务"
        aria-label="保存这条任务"
        onClick={onSave}
      ><Check size={16} /></button>
    </div>
  );
}
