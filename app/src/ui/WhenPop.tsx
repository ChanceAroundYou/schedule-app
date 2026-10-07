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
 *      底部因此不再有那个共用的出口，只剩一个「收起」。
 *
 * **不做「最近用过的日期」快捷推荐**：这个面板里再塞一行 chips 就放不下了，
 * 而且这是个日程管理软件 —— 日期是**选出来**的，不是**猜出来**的。
 *
 * 定位照抄原来的 DatePop / ClockPop：`position: fixed` + 按 anchor 实算，
 * 下方放不下就翻到上面、右边超出就往左收。不新造一套定位逻辑。
 *
 * 月历格子与顶栏「找日期」（JumpPop）共用 `MiniCalendar` —— 密度短横的
 * `loadOf` 也是同一个 `jumpLoad`，所以那个指示只有一处实现。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import * as D from '../domain/date.ts';
import { ClockBody } from './Clock.tsx';

/** 面板里那只表盘比抽屉里的小一号：这个面板宽 268，扣掉内边距只剩 234，
 *  塞 246 的表盘会顶到边 */
const FACE = 198;

/* ============================== 月历格子（两处共用） ============================== */

export interface MiniCalendarProps {
  /** 当前显示月份的 1 号 */
  month: string;
  /** 高亮哪个格子（默认值 / 已选值）。null = 不高亮 */
  value: string | null;
  /** 给「今天」描边 */
  todayIso: string;
  /** 那天的未完成数，画淡底 + 底部短横（口径由调用方给，两处共用同一份） */
  loadOf: (iso: string) => number;
  /** 翻月 */
  onMonth: (iso: string) => void;
  /** 点某天 */
  onPick: (iso: string) => void;
}

export function MiniCalendar({ month, value, todayIso, loadOf, onMonth, onPick }: MiniCalendarProps) {
  const days = D.monthMatrix(month);
  const curMonth = D.parseISO(month).getMonth();
  return (
    <>
      <div className="jp-head">
        <button className="jp-nav" title="上个月" onClick={() => onMonth(D.addMonths(month, -1))}>
          <ChevronLeft size={14} />
        </button>
        <span className="jp-label">
          {D.parseISO(month).getFullYear()} 年 {D.parseISO(month).getMonth() + 1} 月
        </span>
        <button className="jp-nav" title="下个月" onClick={() => onMonth(D.addMonths(month, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="jp-week">
        <span>一</span><span>二</span><span>三</span><span>四</span>
        <span>五</span><span>六</span><span>日</span>
      </div>

      <div className="jp-grid">
        {days.map((d) => {
          const out = D.parseISO(d).getMonth() !== curMonth;
          const n = loadOf(d);
          // 类名对不上等于没写：CSS 里是 `.jp-cell`，不是 `.jp-day`
          return (
            <button
              // 日期密度用**淡底 + 底部短横**，不用圆点 —— 圆点在 1x 屏上几乎看不见
              className={'jp-cell' + (out ? ' out' : '')
                + (d === todayIso ? ' today' : '')
                + (d === value ? ' cur' : '')
                + (n ? ' has' + (n >= 6 ? ' lv3' : n >= 3 ? ' lv2' : '') : '')}
              key={d}
              data-jump={d}
              title={D.fmtFull(d) + ' · ' + (n ? n + ' 项待办' : '空闲')}
              onClick={() => onPick(d)}
            >{D.parseISO(d).getDate()}</button>
          );
        })}
      </div>
    </>
  );
}

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

  /* 标题行右边那个按钮**就是「不设置」，只是按当前状态换个说法**（需求 3）：
     它贴着开合箭头放，日期、时间各点各的，不再共用一个底部出口。

       - 已经有值 → 「清空」：把这个字段清成未设置，**面板留着**（多半是想重选）。
         清时间要连表盘一起复位，见上面 dialKey 那段。
       - 还没有值 → 「跳过」：没什么可清的，那就往前走一步 ——
         日期行跳去时间层，时间行直接收起面板。

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
    return { label: '跳过', run: () => setLayer(key === 'date' ? 'time' : null) };
  };

  const row = (key: 'date' | 'time', label: string, value: string | null, text: string) => {
    const act = actOf(key);
    return (
      <div className={'wp-row' + (layer === key ? ' open' : '')}>
        {/* 开合键和「清空 / 跳过」必须是**两个** button —— 嵌套 button 是非法
            HTML，浏览器会把里层那个甩到外面去，点起来完全不是看到的样子 */}
        <button
          className="wp-head"
          type="button"
          aria-expanded={layer === key}
          data-layer={key}
          onClick={() => setLayer((v) => (v === key ? null : key))}
        >
          <span className="wp-k">{label}</span>
          <span className={'wp-v' + (value ? '' : ' none')}>{value ? text : '未设置'}</span>
          <ChevronDown size={14} className="wp-cv" />
        </button>
        <button className="wp-act" type="button" onClick={act.run}>{act.label}</button>
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

      <div className="wp-foot">
        <span className="grow" />
        <button className="ghost-btn" onClick={onClose}>收起</button>
      </div>
    </div>
  );
}
