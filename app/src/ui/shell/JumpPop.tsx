/**
 * JumpPop.tsx —— 找日期面板
 */

import { useEffect, useRef, useState } from 'react';
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { useOutsideClose } from '../hooks.ts';
import { Input } from '../kit.tsx';
import { MiniCalendar } from '../MiniCalendar.tsx';

/** 某天**还没做完**的任务数 —— 面板用它表示「哪天忙」 */
function jumpLoad(state: LocalState, isoDay: string): number {
  let n = 0;
  for (const k in state.tasks) {
    const t = state.tasks[k];
    if (t.date === isoDay && !t.deleted && !t.done) n++;
  }
  return n;
}

function JumpPop({ open, cursor, state, onPick, onClose, triggerRef }: {
  open: boolean; cursor: string; state: LocalState;
  onPick: (iso: string) => void; onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => D.monthStart(cursor));
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);

  useOutsideClose(box, open, onClose, triggerRef);
  useEffect(() => { if (open) { setMonth(D.monthStart(cursor)); setText(''); setBad(false); } }, [open, cursor]);

  if (!open) return null;

  const go = (v: string) => {
    // 基准用**面板所在月份**，不是今天 —— 见 domain/date.ts 的 parseDateText
    const d = D.parseDateText(v, month);
    if (d) { onPick(d); return; }
    setBad(true);
  };

  return (
    <div className="jump-pop" ref={box}>
      <div className="jp-row">
        <Input
          type="text"
          value={text}
          placeholder="输入日期，如 10月15日"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(text); }}
        />
        {/* 「跳转」保持原样：它有自己的 @media (hover:none) 触屏规则（styles/shell.css
            里那几条 .jp-go），换成 Btn 就得把那些选择器一起改 —— 而它是
            输入框的提交伙伴，跟 .fast-clock / .clear-search 同一类 */}
        <button className="jp-go" onClick={() => go(text)}>跳转</button>
      </div>

      {/* 月历格子与快速添加那个「日期 + 时间」面板共用同一份 —— 见 ui/WhenPop.tsx */}
      <MiniCalendar
        month={month}
        value={cursor}
        todayIso={D.today()}
        loadOf={(iso) => jumpLoad(state, iso)}
        onMonth={setMonth}
        onPick={onPick}
      />

      {bad && <div className="jp-bad">没看懂这个日期，换个写法试试（例如「10月15日」「下周三」）</div>}
    </div>
  );
}

export { JumpPop };
