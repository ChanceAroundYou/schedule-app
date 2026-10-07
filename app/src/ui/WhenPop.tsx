/**
 * WhenPop —— 快速添加横条上「日期 + 时间」那块面板
 *
 * 两层叠着往下展开：**上面一层日期，下面一层时间**，各点各的标题行开合。
 * 三条口径（需求里点名的，别改回去）：
 *
 *   1. **两层不能同时开着。** 一个 268px 宽的面板里塞两套展开内容，翻月历
 *      和拨表盘会打架；而且这两件事本来就是先后关系 —— 先定哪天、再定几点。
 *   2. **打开时没日期就先开日期层，已经有日期就先开时间层。** 「已经有日期」
 *      包括**跟着 tab 来的默认值**（今天页 = 今天、日程页 = 光标那天），
 *      不是只看用户手动挑没挑过。
 *   3. **在日期层点中某天 → 自动收起日期层、切到时间层。** 挑完日期下一步
 *      几乎总是挑时间，让用户再点一次标题行纯属多余。
 *      **时间已经定过的话就直接收起整个面板** —— 两样都齐了，没有下一步了。
 *   4. **分钟一落定，整个面板自己收起**（需求 5）。`ClockBody` 的 `onMinutePick`
 *      就是为这个加的：选小时只是半截，选到分钟才算选完。
 *   5. **「不设置」拆成两个，贴着各自的标题行**（需求 3）：日期、时间各点各的。
 *      文案跟着状态走 —— 有值写「清空」、没值写「跳过」，见 `actOf`。
 *      两个都放在**开合箭头左边**（需求 6）：动作排在开合前面。
 *   6. **面板没有底部出口**（需求 7）。原先那个「收起」是面板里唯一的出口，
 *      现在点面板外面就收 —— 出口不该只长在底部。这也顺带把 `.wp-foot` 整块删了。
 *      面板的 DOM 父节点是横条，所以「点外面」和横条自己的「点空白收起」
 *      是同一件事的两级（先收面板、再收横条），见需求 8。
 *      处理集中在 `Shell.tsx` 的 QuickAdd，这里只留 Esc。
 *
 * **不做「最近用过的日期」快捷推荐**：这个面板里再塞一行 chips 就放不下了，
 * 而且这是个日程管理软件 —— 日期是**选出来**的，不是**猜出来**的。
 *
 * 定位照抄原来的 DatePop / ClockPop：`position: fixed` + 按 anchor 实算，
 * 下方放不下就翻到上面、右边超出就往左收。不新造一套定位逻辑。
 *
 * 日期层用的月历格子是**独立组件** `ui/MiniCalendar.tsx`（需求 4），与顶栏
 * 「找日期」（JumpPop）共用同一份；密度短横的 `loadOf` 也是同一个 `jumpLoad`，
 * 所以那个指示只有一处实现。时间层用的表盘是 `ui/Clock.tsx` 的 `ClockBody`，
 * 抽屉里那个浮层（ClockPop）用的是同一只。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import * as D from '../domain/date.ts';
import { ClockBody } from './Clock.tsx';
import { MiniCalendar } from './MiniCalendar.tsx';

/** 面板里那只表盘比抽屉里的小一号：这个面板宽 268，扣掉内边距只剩 234，
 *  塞 246 的表盘会顶到边 */
const FACE = 198;

/* ============================== 面板本体 ============================== */

export interface WhenPopProps {
  open: boolean;
  /** 面板贴着哪个元素出现（横条上那个时钟按钮）。为空就不渲染 */
  anchor: HTMLElement | null;
  /** **生效**日期 —— 已经含了 tab 默认与文本解析的结果。
   *  标题行上写的、月历里高亮的、按钮文本上写的，必须是同一个值 */
  date: string | null;
  /** **生效**时间，同上 */
  time: string | null;
  todayIso: string;
  loadOf: (iso: string) => number;
  /** 点某天 → 面板自己收日期层、开时间层。传 `null` = 把日期清成未设置 */
  onDate: (v: string | null) => void;
  /** 拨表盘 → 实时回传 'HH:MM'。传 `null` = 把时间清成未设置 */
  onTime: (v: string | null) => void;
  /** 点外 / Esc / 「收起」/ 选完 → 收起面板（已选的值留着） */
  onClose: () => void;
}

export function WhenPop({
  open, anchor, date, time, todayIso, loadOf,
  onDate, onTime, onClose,
}: WhenPopProps) {
  const box = useRef<HTMLDivElement>(null);
  const [layer, setLayer] = useState<'date' | 'time' | null>(null);
  const [month, setMonth] = useState(() => D.monthStart(date || todayIso));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // 清掉时间之后要把表盘一起复位，但表盘的状态在它自己肚子里 ——
  // 换 key 让它重新挂载是唯一的办法（不能拿 time 当 key：每拨一下都会重挂，
  // 用户刚切到的分钟档会被弹回小时档）
  const [dialKey, setDialKey] = useState(0);

  /* 只在**打开的那一下**决定先开哪层、把月份拨到当前日期所在的月。
     刻意盯着 open 的上升沿而不是直接跟 date：date 在面板开着的时候会变
     （用户点了一格），跟着它走会把用户刚翻到的月份弹回去。 */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setLayer(date ? 'time' : 'date');
      setMonth(D.monthStart(date || todayIso));
    }
    wasOpen.current = open;
  }, [open, date, todayIso]);

  /* 定位要在 useLayoutEffect 里量：放到 useEffect 会先画在左上角再跳过来。
     高度跟着开哪层 / 哪个月变，所以这几样都在依赖里 */
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
  }, [open, anchor, layer, month]);

  /* Esc 关掉面板。要 stopImmediatePropagation —— 否则 App 那层的 Esc
     会跟着再关一次抽屉。

     **点外面那件事不在这儿管**（需求 7 / 8）：面板是横条的 DOM 子节点，
     而横条自己也要「点空白收起」，两级还得有先后（先收面板、再收横条）。
     两处各挂一个 document 上的 capture 监听必然打架 —— 谁先跑取决于注册
     顺序，而两边都以为对方该让路。所以整件事收在 `Shell.tsx` 的 QuickAdd
     里，一个 handler 同时看得见「面板开没开」和「横条开没开」。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  /* 标题行右边那个按钮**就是「不设置」，只是按当前状态换个说法**（需求 3）：
     它贴着开合箭头放，日期、时间各点各的，不再共用一个底部出口。

       - 已经有值 → 「清空」：把这个字段清成未设置，**面板留着**（多半是想重选）。
         清时间要连表盘一起复位，见上面 dialKey 那段。
       - 还没有值 → 「跳过」：没什么可清的，那就往前走一步 ——
         日期行跳去时间层，时间行没什么可跳的了，直接收起面板。

     两种状态下点下去都有明确后果，不留一个点了没反应的死按钮。 */
  const actOf = (key: 'date' | 'time') => {
    const has = key === 'date' ? !!date : !!time;
    if (has) {
      return {
        label: '清空',
        run: () => {
          if (key === 'date') onDate(null);
          else { onTime(null); setDialKey((k) => k + 1); }
        },
      };
    }
    return {
      label: '跳过',
      run: () => { if (key === 'date') setLayer('time'); else onClose(); },
    };
  };

  const row = (key: 'date' | 'time', label: string, value: string | null, text: string) => {
    const act = actOf(key);
    const open = layer === key;
    const toggle = () => setLayer((v) => (v === key ? null : key));
    return (
      <div className={'wp-row' + (open ? ' open' : '')}>
        {/* 三个**平级**的 button，不能嵌套 —— 嵌套 button 是非法 HTML，
            浏览器会把里层那个甩到外面去，点起来完全不是看到的样子；
            换成 button 里塞 `role="button"` 的 span 也一样是嵌套交互元素，
            读屏会当成两个控件来回问。 */}
        <button
          className="wp-head"
          type="button"
          aria-expanded={open}
          data-layer={key}
          onClick={toggle}
        >
          <span className="wp-k">{label}</span>
          <span className={'wp-v' + (value ? '' : ' none')}>{value ? text : '未设置'}</span>
        </button>
        {/* 「清空 / 跳过」在**箭头左边**（需求 6）：动作排在开合前面 */}
        <button className="wp-act" type="button" onClick={act.run}>{act.label}</button>
        <button
          className="wp-cv"
          type="button"
          aria-expanded={open}
          aria-label={label + (open ? '：收起' : '：展开')}
          onClick={toggle}
        ><ChevronDown size={14} /></button>
      </div>
    );
  };

  return (
    <div
      className="when-pop"
      ref={box}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        // 量之前先藏起来，免得在左上角闪一帧
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {row('date', '日期', date, date ? D.fmtMD(date) + ' 周' + D.weekdayShort(date) : '')}
      {layer === 'date' && (
        <div className="wp-body">
          <MiniCalendar
            month={month}
            value={date}
            todayIso={todayIso}
            loadOf={loadOf}
            onMonth={setMonth}
            onPick={(d) => {
              onDate(d);
              // 时间已经定了 → 日期时间两样都齐，直接收起（需求 5）；
              // 还缺时间 → 切到时间层接着选
              if (time) onClose(); else setLayer('time');
            }}
          />
        </div>
      )}

      {row('time', '时间', time, time || '')}
      {layer === 'time' && (
        <div className="wp-body wp-clock">
          {/* 分钟一落定就算选完 → 面板自己收起（需求 5）。
              这里不需要「清除时间」了：它挪到标题行右边，见上面 actOf */}
          <ClockBody
            key={dialKey}
            value={time}
            face={FACE}
            onChange={onTime}
            onMinutePick={onClose}
          />
        </div>
      )}
    </div>
  );
}
