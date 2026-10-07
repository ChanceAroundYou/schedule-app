/**
 * ClockBody / ClockPop —— 12 小时制时间转盘
 *
 * 这是从旧版 `legacy/clock.js` 移植过来的，重构时丢过一次。
 *
 * **为什么不直接用原生 `<input type="time">`**：那个控件在手机上确实好用，
 * 但在桌面上，一个嵌入式的时间输入框要点开系统控件才能改，而要改的往往只是
 * 「把 9 点挪到 10 点」这种一格的事。这个转盘一次点击就够，还有
 * 「现在」这个高频动作。
 *
 * 表盘按**真实时钟的画法**：12 在顶部，顺时针转一圈，靠上面的「上午 / 下午」
 * 区分两圈。比 24 小时制的一圈 24 个数好用 —— 一圈 24 个数每个只有 15°，
 * 手指粗细的量级，必然点不准。
 *
 * **上面那排数字写的是 24 小时制**（下午 3 点就是 15，不是 03）。这是跟
 * 「下午那圈直接写 12–23」配套的：表盘上点的是 15、上面显示的却是 03，
 * 用户会以为点错了。上午圈写 0–11（午夜是 0，不是 12），和按钮/输入框
 * 显示的 HH:MM 完全一致 —— 标签就是点下去得到的那个值。
 *
 * 两处分身，**表盘本体只有一份**：
 *   · `ClockBody` —— 表盘本身，不带定位、不带「确定 / 取消」。谁要谁嵌。
 *   · `ClockPop`  —— 任务抽屉里那个贴着按钮弹出的浮层（`position: fixed`）。
 *   快速添加里那个面板用的是 `ClockBody`，嵌在 `ui/WhenPop.tsx` 的「时间」层里。
 *
 * 三个口径上的决定（改之前先看，都是被问过的）：
 *
 * 1. **下午那圈直接写 12–23，不用心算 +12。** 不是「13–24」：24 点在钟面顶端
 *    对应的是 12 点（正午），标成 24 会点出 12:xx —— 标签和结果对不上。
 *    13 落在 1 点钟位置，和上午那圈同一个物理位置，手感不用重学。
 * 2. **分钟那圈写 60,5,10,…,55**，跟真钟表的分钟圈一样，顶端那个 60 就是 0 分。
 *    这不是笔误：60 分 ≡ 0 分，和上面「24 点 ≠ 12 点」是两回事。
 * 3. **分钟只给 12 格（每 5 分钟）**，不做逐分钟：这个应用的时间轴最小步进是
 *    15 分钟（拖拽、拉伸都按这个档），给到 1 分钟的精度没有意义，
 *    只会让用户在上面戳半天。
 * 4. **面板里没有大号的时间显示。** 原先表盘上面摆着两个 27px 的数字，
 *    可生效时间早就写在横条那个按钮上了（`.fast-clock .fc-t`）—— 面板里
 *    再重复一遍纯属占地方，而这个面板只有 234px 宽，表盘已经占掉 198。
 *    时 / 分圈的切换改由表盘正中心那个点承担（点一下切圈）。
 * 5. **表盘下面不写说明文字。** 原先有一行 `.cp-tip`，内容是「选小时（12 在顶部）」
 *    这类话 —— 表盘自己就画着 12 在顶部，用户看得见；写出来只是把人当不会看。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as D from '../domain/date.ts';
import { Btn } from './kit.tsx';

/** 抽屉里那个浮层的表盘直径。`.clock-pop` 的 278px 宽度就是按它配出来的
 *  （278 扣掉两条 1px 边框和左右各 15px 内边距 = 246），见 legacy.css 那段注释 */
const FACE_POP = 246;
/** 数字环离表盘边缘的距离。246/2 - 29 = 94，正是重构前写死的那个半径 */
const R_INSET = 29;

/* ============================== 表盘本体 ============================== */

export interface ClockBodyProps {
  /** 初值 'HH:MM'，null = 未定时。**只在挂载那一刻读一次** ——
   *  之后内部状态才是真相（调用方每次拨动都会把新值传回来，
   *  跟着它走等于自己盖自己，而且会把用户刚切到的分钟档弹回小时档）。
   *  想从外部重置，换 `key` 让它重新挂载。 */
  value: string | null;
  /** 表盘直径。抽屉里 246，快速添加那个窄面板里给更小的一只 */
  face?: number;
  /** 每次拨动**立刻**回调 'HH:MM'（不是等「确定」）—— 调用方要的就是实时 */
  onChange: (v: string) => void;
  /** 点了**分钟**那圈之后回调一次 —— 到这里一次选择就算走完了。
   *  快速添加那层面板拿它自动收起（需求 5）；抽屉里那个浮层不传，
   *  它有自己的「确定 / 取消」，不能自己关。 */
  onMinutePick?: () => void;
}

export function ClockBody({ value, face = FACE_POP, onChange, onMinutePick }: ClockBodyProps) {
  const init = D.timeToMin(value);
  const [mode, setMode] = useState<'h' | 'm'>('h');
  // 没有值时给**当前整点**而不是 09:00 ——「新建一件现在要做的事」比
  // 「早上九点要做的事」常见得多
  const [hour, setHour] = useState(() => init == null ? Math.floor(D.nowMin() / 60) : Math.floor(init / 60));
  const [minute, setMinute] = useState(() => init == null ? 0 : init % 60);

  const C = face / 2;            // 表盘中心
  const R = face / 2 - R_INSET;  // 数字环半径

  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const isAm = hour < 12;
  const isHour = mode === 'h';

  /* 表盘上 12 个位置，k = 0 是顶端（12 点位置），顺时针。
     标签必须**等于点下去得到的那个值**，否则用户点「3」出来 15 会以为坏了。
     上午圈写 0–11（午夜是 0），下午圈写 12–23，和按钮/输入框的 HH:MM 一致。 */
  const labelOf = (k: number) => isHour
    ? (isAm ? k : k + 12)
    : (k === 0 ? 60 : k * 5);

  /** 当前值落在第几个位置 —— 指针角度和「哪个数高亮」都用它 */
  const curK = isHour ? (h12 === 12 ? 0 : h12) : Math.round(minute / 5) % 12;
  const ang = (curK / 12) * 360 - 90;

  const emit = (h: number, mi: number) => onChange(D.pad(h) + ':' + D.pad(mi));

  const pick = (k: number) => {
    if (isHour) {
      // 顶端在上午是 0 点、下午是 12 点；其余位置上午就是 k、下午是 k+12
      const h = k === 0 ? (isAm ? 0 : 12) : (isAm ? k : k + 12);
      setHour(h);
      emit(h, minute);
      setMode('m');            // 选完小时自动进分钟档
    } else {
      const mi = k * 5;        // 顶端那格（标签写 60）就是 0 分
      setMinute(mi);
      emit(hour, mi);
      onMinutePick?.();        // 分钟落定 = 这次选择走完了
    }
  };

  const setAmPm = (am: boolean) => {
    const h = (hour % 12) + (am ? 0 : 12);
    setHour(h);
    emit(h, minute);
  };

  const now = () => {
    const n = D.nowMin();
    const h = Math.floor(n / 60), mi = n % 60;
    setHour(h); setMinute(mi); emit(h, mi);
  };

  return (
    <>
      {/* 上午 / 下午**仍然居中**（需求 5）：「现在」挂在组的右边，但走绝对定位，
          不是当第三个 flex 子元素 —— 那样整组会被挤偏，而这两个键的居中
          是这个面板的视觉基准线。 */}
      <div className="cp-ampm">
        <span className="cp-apm">
          <button className={'cp-ap' + (isAm ? ' on' : '')} onClick={() => setAmPm(true)}>上午</button>
          <button className={'cp-ap' + (!isAm ? ' on' : '')} onClick={() => setAmPm(false)}>下午</button>
          <button className="cp-now" onClick={now}>现在</button>
        </span>
      </div>

      {/* 大号的时间显示**没有**（需求 4）：生效时间已经写在横条那个按钮上
          （`.fast-clock .fc-t`），面板里再摆两个 27px 的数字纯属占地方 ——
          这个面板只有 234px 宽，表盘已经占掉 198。 */}
      <div className="cp-face" style={{ width: face + 'px', height: face + 'px' }}>
        <i className="cp-hand" style={{ width: R + 'px', transform: `rotate(${ang}deg)` }} />
        {/* 点正中心 = 在时圈 / 分圈之间切。原先这个切换是显示行上那两个大数字
            （点「小时」那个数切回小时档），显示行删了之后总得有个地方切，
            而中心那个点本来就在指针轴上，点它最自然。
            上面写「时」还是「分」是**状态**，不是提示 —— 不写的话，同一个
            位置上那 12 个数是 12 点还是 12 分，只能靠数数猜。 */}
        <button
          type="button"
          className={'cp-dot' + (isHour ? ' h' : ' m')}
          title={isHour ? '切到分钟' : '切到小时'}
          aria-label={isHour ? '切到分钟' : '切到小时'}
          onClick={() => setMode(isHour ? 'm' : 'h')}
        >{isHour ? '时' : '分'}</button>
        {Array.from({ length: 12 }, (_, k) => {
          const a = ((k / 12) * 360 - 90) * Math.PI / 180;
          return (
            <button
              className={'cp-num' + (k === curK ? ' on' : '')}
              key={k}
              style={{ left: (C + R * Math.cos(a)) + 'px', top: (C + R * Math.sin(a)) + 'px' }}
              onClick={() => pick(k)}
            >{labelOf(k)}</button>
          );
        })}
      </div>
    </>
  );
}

/* ============================== 抽屉里那个浮层 ============================== */

export interface ClockPopProps {
  open: boolean;
  /** 弹层贴着哪个元素出现。为空就不渲染 */
  anchor: HTMLElement | null;
  /** 当前值 'HH:MM'，null = 未定时 */
  value: string | null;
  /** 点「确定」回传 'HH:MM'，点「清除」回传 null */
  onChange: (v: string | null) => void;
  onClose: () => void;
}

export function ClockPop({ open, anchor, value, onChange, onClose }: ClockPopProps) {
  const box = useRef<HTMLDivElement>(null);
  // 表盘是实时的，但抽屉里要「取消 = 反悔」：所以先攒在这儿，点确定才交出去
  const [draft, setDraft] = useState<string | null>(value);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* 每次打开都从当前值重新起步（上次点开拨了一半又取消的那半截不能留下） */
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  /* 定位要在 useLayoutEffect 里量：放到 useEffect 会先画在左上角再跳过来，
     窄屏那一帧的闪动很明显 */
  useLayoutEffect(() => {
    if (!open || !anchor || !box.current) { setPos(null); return; }
    const r = anchor.getBoundingClientRect();
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    let top = r.bottom + 6;
    let left = r.left;
    // 下方放不下就翻到上面；右边超出就往左收。都留 8px 边距
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    setPos({ top, left });
  }, [open, anchor]);

  /* 点外面关掉 / Esc 关掉。Esc 要 stopImmediatePropagation ——
     否则 App 那层的 Esc 会跟着再关一次抽屉 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t)) return;
      if (anchor?.contains(t)) return;   // 点按钮本身由按钮自己 toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;

  return (
    <div
      className="clock-pop"
      ref={box}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        // 量之前先藏起来，免得在左上角闪一帧
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <ClockBody value={value} onChange={setDraft} />

      <div className="cp-foot">
        <Btn variant="chip" size="sm" onClick={() => { onChange(null); onClose(); }}>清除</Btn>
        <span className="grow" />
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" onClick={() => { onChange(draft); onClose(); }}>确定</Btn>
      </div>
    </div>
  );
}
