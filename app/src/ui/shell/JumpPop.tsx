/**
 * JumpPop.tsx —— 找日期面板
 */

import { useEffect, useRef, useState } from 'react';
import type { LocalState } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { undoneLoadOf } from '../../domain/model.ts';
import { useAnchoredPosition, useOutsideClose } from '../hooks.ts';
import { Input } from '../kit.tsx';
import { MiniCalendar } from '../overlays/MiniCalendar.tsx';

function JumpPop({ open, cursor, state, onPick, onClose, triggerRef }: {
  open: boolean; cursor: string; state: LocalState;
  onPick: (iso: string) => void; onClose: () => void;
  /** 触发按钮（顶栏那颗日历图标）。**必填** —— 浮层按它定位；给 null 的话
   *  浮层会一直是 `visibility: hidden`（量不到位置就不许露头，见 useAnchoredPosition）。 */
  triggerRef: React.RefObject<HTMLElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  /* 浮层**按视口定位**（fixed + 量出来再摆），不再靠 CSS 的 `left/right` 贴边。
     手机端原来那条 `right: 0` 让面板往左伸到屏幕外 —— 390 宽的屏上量出来
     `left:-155`，一半被裁掉（用户 2026-11-02 报「只显示了一半」）。
     算式在 `domain/layout.ts` 的 placePanel（会被翻到上方、并往回收进视口），
     与 DatePicker / TimePicker / 抽屉同一处，不再各写一套。 */
  const [month, setMonth] = useState(() => D.monthStart(cursor));
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  /* 依赖里带 `month`：翻月后面板高度会变（6 周 vs 5 周），得重新量一次 */
  const pos = useAnchoredPosition(triggerRef, box, open, [month]);

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
    <div
      className="jump-pop"
      ref={box}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        /* 量之前先藏着 —— 否则会在左上角闪一帧再跳到正确位置 */
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className={"jp-row"}>
        <Input
          type="text"
          value={text}
          placeholder="输入日期，如 10月15日"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(text); }}
        />
        {/* 「跳转」保持原样：它有自己的 @media (hover:none) 触屏规则（shell.css
            里那几条 .jp-go），换成 Btn 就得把那些选择器一起改 —— 而它是
            输入框的提交伙伴，跟 .fast-clock / .clear-search 同一类 */}
        <button className="jp-go" onClick={() => go(text)}>跳转</button>
      </div>

      {/* 月历格子与快速添加那个「日期 + 时间」面板共用同一份 —— 见 ui/WhenPop.tsx。
          密度口径 = domain 里唯一的「这天还有几条没做完」（含今天没打的卡）。 */}
      <MiniCalendar
        month={month}
        value={cursor}
        todayIso={D.today()}
        loadOf={undoneLoadOf(state)}
        onMonth={setMonth}
        onPick={onPick}
      />

      {bad && <div className="jp-bad">没看懂这个日期，换个写法试试（例如「10月15日」「下周三」）</div>}
    </div>
  );
}

export { JumpPop };
