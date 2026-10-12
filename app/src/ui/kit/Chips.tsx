/**
 * Chips —— 胶囊选择器
 */

import type { ReactNode } from 'react';
import { Btn } from './Btn.tsx';

/**
 * 一排二选一 / 多选一的胶囊。
 *
 * **不是 `<select>`**：原生 select 在 PWA 里样式不可控、和项目设计系统不一致，
 * 且移动端体验差。小选项集（≤ 7 个固定选项）一律用这个。
 *
 * **每个胶囊就是一个 `Btn`**（`chip` / `chipOn` 两档），不是另画一套。
 * 原先这里自己写了一遍 `rounded-[var(--r-pill)] border …`，和 `Btn` 差在三处：
 * 圆角走的是 `--r-pill` 而按钮走 `--r-md`、边框写死 Tailwind 的 `border`（1px）
 * 而按钮走 `--border-w`、未选中用装饰线 `--border` 而按钮用 ≥3:1 的 `--input`。
 * 于是「切到 flat 时别的按钮线变 2px、这几个还是 1px」「切到 notion 时圆角
 * 和旁边按钮不是一个数」—— 用户看到的就是「颜色和风格这些按钮跟别的不一样」。
 * 组件库的意义就是**没有第二套**，所以这里只有 `Btn` 一种画法。
 *
 * 全局原则见 CLAUDE.md「三、界面约定」末尾。
 */
export function Chips<K extends string | number>({ value, options, onPick, render, labelOf, label, labelledBy }: {
  value: K;
  options: readonly K[];
  onPick: (k: K) => void;
  /** 色板那一轴要在胶囊里画一个色点 */
  render?: (k: K) => ReactNode;
  /** 把选项 key 显示成什么文字。不传就用 key 本身 */
  labelOf?: (k: K) => string;
  /** 这组控件的无障碍名字（没有可见标签时用） */
  label?: string;
  /** 有可见标签时，指向那个标签元素的 id —— 比 label 更准，且不用把文字写两遍 */
  labelledBy?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map((k) => {
        const on = k === value;
        return (
          <Btn
            key={String(k)}
            data-pick={k}
            aria-pressed={on}
            onClick={() => onPick(k)}
            variant={on ? 'chipOn' : 'chip'}
            size="sm"
          >
            {render?.(k)}
            {labelOf ? labelOf(k) : k}
          </Btn>
        );
      })}
    </div>
  );
}
