/**
 * DayGrid —— 一组日子（1–31）的方格选择器
 *
 * 视觉完全走日历那一套（`.jp-grid` / `.jp-cell`），所以重复面板里
 * 「每月几号」「每年几月几号」跟日期选择器看起来是同一个东西。
 *
 * **和 `MiniCalendar` 的区别只有一条，但很要紧**：MiniCalendar 按**真实月份**
 * 排（前后补空格对齐星期），这个**不排** ——「每月 31 号」在 2 月也存在
 * （顺延到月末），所以 1–31 就是齐整整五排，中间不该有空格。
 * 这也是当初不直接复用 MiniCalendar 的原因。
 */

export function DayGrid({ count = 31, selected, onPick, label }: {
  /** 几天。默认 31（一个月最多 31 天） */
  count?: number;
  /** 选中几号 */
  selected: number;
  onPick: (d: number) => void;
  label: string;
}) {
  return (
    <div className="jp-grid" role="group" aria-label={label}>
      {Array.from({ length: count }, (_, i) => i + 1).map((d) => (
        <button
          key={d}
          type="button"
          className={'jp-cell' + (d === selected ? ' cur' : '')}
          aria-pressed={d === selected}
          onClick={() => onPick(d)}
        >{d}</button>
      ))}
    </div>
  );
}