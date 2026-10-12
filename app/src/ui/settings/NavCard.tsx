/**
 * NavCard.tsx —— 功能区自定义卡片
 */

import { useEffect, useState } from 'react';
import { Check, GripVertical, PanelTop } from 'lucide-react';
import { type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { LocalState } from '../../domain/types.ts';
import { TAB_MAX, orderTabs } from '../../domain/model.ts';
import * as store from '../../data/store.ts';
import { Card, Field } from '../kit.tsx';
import { navDef } from '../Shell.tsx';
import { useIsNarrow } from '../hooks.ts';
import { SortableZone, useSortableItem } from '../dndkit.tsx';
import { cx } from '../cx.ts';

const HOVER = 'hover:bg-[var(--panel-3)]';

/**
 * 功能区自定义：一格一个功能项，**点一下切换显示 / 隐藏，拖一下排序**。
 *
 * 勾选的含义在两种设备上是同一个：**勾上 = 在这个设备的功能区里显示**。
 *   宽屏 · 功能区 = 侧栏那一列   → 不勾 = 藏起来（`ui.navHidden`）
 *   窄屏 · 功能区 = 底栏那 4 格   → 不勾 = 不进底栏，在「更多」抽屉里
 *
 * 原先宽屏那一半的勾选框管的是 `navBottom`（「挪到侧栏下面那一组」），
 * 于是点一下打勾，这一项就从侧栏主列里**消失**、跑到下面去了 —— 用户看到的是
 * 「勾选时消失，未勾选时显示」，正好反着。而且它的名字（勾）说的是「要不要它」，
 * 干的事却是「换个位置」，两回事。现在勾就是显示，位置只由拖拽决定。
 *
 * 为什么藏起来要用 `navHidden` 而不是把它从 `navOrder` 里删掉：`normalizeUi`
 * 会把缺的键补回 `navOrder`（老用户本地那份顺序里没有新页），删了刷新就回来。
 *
 * **次序：显示中的全排在前面，被隐藏的排到最后。** 不画分组标题、不加分隔线
 * （「这是次序不是两栏」）。拖的时候手上不受限，只有**落点**会被钳回本组：
 * 显示项被拖进隐藏区 → 落到显示组末位；隐藏项被拖进显示区 → 落到隐藏组最前位。
 * 原先两组混着排，用户看到的是「真正显示的功能区夹在藏起来的中间」。
 *
 * **宽屏藏起来 ≠ 够不着**：侧栏底部那个「更多」入口列出的就是这些项
 * （见 Shell.tsx 的 SidebarMore）—— 窄屏有底栏那个「更多」抽屉，桌面原本没有，
 * 一勾掉就只剩设置页能找回来。
 *
 * 拖拽走 @dnd-kit：MouseSensor 处理鼠标输入。移动 8px 才开始拖 ——
 * 轻点（不移动）不会触发拖，所以「点一下切换」不受影响。
 */
function NavCard({ state }: { state: LocalState }) {
  const ui = state.ui;
  const order = ui.navOrder;
  const tabs = ui.tabs;
  const hidden = new Set(ui.navHidden);
  const narrow = useIsNarrow();

  const [rows, setRows] = useState<string[]>(order);
  useEffect(() => setRows(order), [order]);

  /** 勾选口径跟着设备走：窄屏是底栏那几项，宽屏是侧栏里没被藏起来的那些 */
  const isOn = (k: string) => (narrow ? tabs.includes(k) : !hidden.has(k));

  /* 网格里的次序：**显示中的全部排在前面，被隐藏的排到最后**。
     不画分组标题、不加分隔线 —— 这是「次序」不是「两栏」（用户 2026-10-09 裁决：
     「不需要显式的两组功能区，样式上不变」）。`navOrder` 仍是一份完整顺序，
     这里只决定怎么摆。 */
  const shown = rows.filter(isOn);
  const rest = rows.filter((k) => !isOn(k));
  const grid = [...shown, ...rest];

  /** 写顺序时**必须连 `tabs` 一起写**：底栏读的是 `ui.tabs` 自己的顺序，
   *  而 `setUi` 是个裸的浅合并（不归一），只写 `navOrder` 的话窄屏底栏要等到
   *  下次 `normalizeUi`（刷新 / 导入）才跟着变 —— 见踩坑 49。 */
  const write = (next: string[]) => {
    setRows(next);
    store.setUi({ navOrder: next, tabs: orderTabs(next, tabs) });
  };

  const toggle = (k: string) => {
    if (narrow) {
      if (tabs.includes(k)) {
        if (tabs.length <= 1) return;
        store.setUi({ tabs: orderTabs(order, tabs.filter((x) => x !== k)) });
      } else {
        if (tabs.length >= TAB_MAX) return;
        store.setUi({ tabs: orderTabs(order, [...tabs, k]) });
      }
    } else {
      store.setUi({
        navHidden: hidden.has(k)
          ? ui.navHidden.filter((x) => x !== k)
          : [...ui.navHidden, k],
      });
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = grid.indexOf(String(active.id));
    let newIndex = grid.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    /* **拖是自由的，落点是钳住的。** 一个显示中的项被拖进隐藏区，松手后落到
       「显示组」的末位；反过来一个隐藏项被拖进显示区，落到「隐藏组」的最前位。
       钳的是落点、不是拖的过程 —— 手上不受限，松手才归位（用户 2026-10-09 裁决）。
       钳完 `arrayMove` 出来的就是「显示在前、隐藏在后」的完整顺序，直接当
       `navOrder` 写回去即可（它的分组恰好等于它自己）。 */
    newIndex = isOn(String(active.id))
      ? Math.min(newIndex, shown.length - 1)
      : Math.max(newIndex, shown.length);
    write(arrayMove(grid, oldIndex, newIndex));
  };

  return (
    <Card icon={<PanelTop size={14} />} title="功能区">
      <Field label={narrow ? `底栏 · 最多 ${TAB_MAX} 项（点选 + 拖拽）` : '侧栏 · 点选 + 拖拽'}>
        {/* 自己一套 context（SortableZone）而不是挂在顶层那个上：跟着手指走的
            那一份必须是浮层，顶层故意不挂浮层（挂了时间轴那条就废了）。
            顺带白拿让位动画和原位的占位虚影 —— 见 dndkit.tsx 的 SortableZone。 */}
        <SortableZone
          items={grid}
          onDragEnd={onDragEnd}
          renderGhost={(id) => <div className={cx('nav-chip', CHIP_CX, chipTone(isOn(id)))}><NavChipBody id={id} on={isOn(id)} /></div>}
        >
          {/* 三列网格而不是每项一行：九项一行一个要占 280px 高，一屏就没了。
              网格还有个好处 —— 每格等宽，拖拽时让位的落点是规则的。 */}
          <ul className="grid grid-cols-3 gap-1.5">
            {grid.map((k) => (
              <SortableNavChip key={k} id={k} on={isOn(k)} narrow={narrow} onToggle={toggle} />
            ))}
          </ul>
        </SortableZone>
      </Field>
    </Card>
  );
}

/**
 * 一格的样子。**行本体和浮层里跟着手指走的那一份必须一模一样** ——
 * 抄两遍尺寸就会漂，而落点判定量的正是浮层自己那份的矩形。
 */
const CHIP_CX = 'flex items-center gap-1 rounded-[var(--r-md)] border-[length:var(--border-w)] px-1.5 py-1 text-[12.5px] select-none';
const chipTone = (on: boolean) => (on
  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]'
  : 'border-[var(--border)] text-[var(--text-3)] ' + HOVER);

/** 一格的内容。行和浮层里那份共用 —— 两份长得不一样，拖起来像换了个东西。 */
function NavChipBody({ id, on }: { id: string; on: boolean }) {
  return (<>
    <span className="shrink-0 text-[var(--text-3)]">
      <GripVertical size={12} />
    </span>
    <span className="min-w-0 flex-1 truncate">{navDef(id).label}</span>
    {on && <Check size={12} className="shrink-0" />}
  </>);
}

/**
 * 功能区里一格可排序的导航项。
 *
 * **整行都是拖拽命中区**（`listeners` 在 `<li>` 上），不是只有那个 grip 图标。
 * 原先 listeners 只挂在 12px 的 grip `<span>` 上 —— 必须精确按住那个小图标
 * 才拖得动，按行的其余部分完全没反应，用户报「完全不跟手」。把手现在只剩
 * 视觉提示作用。
 *
 * 走共享的 `useSortableItem`（不另写一份 useSortable + CSS.Translate）：
 * 「只取位移不要缩放」「被拖项不给 transition、其余让位项给 transition」
 * 这两条规则都在那个 hook 里，这里再抄一遍就一定会和它漂。
 *
 * **占位虚影画在落点**（`.drag-land`，判据是 dnd-kit 的 `isOver` = 指针正压着的
 * 那一格），跟着手指走的是 `SortableZone` 浮层里那份实体卡。原先反过来了 ——
 * 虚线画在**被拖项**身上、钉在它出发的那一格（`.nav-chip-drag`），于是手指走了、
 * 虚影远远锁在角落不动，用户报「虚影锁定在原位，不会跟着走」。
 *
 * `data-nav-row` / `data-tab` 是探针认的锚点，别改。`attributes`（带
 * `role="button"`）也照旧挂着 —— 键盘那条路靠它。
 */
function SortableNavChip({ id, on, narrow, onToggle }: {
  id: string;
  on: boolean;
  narrow: boolean;
  onToggle: (k: string) => void;
}) {
  const { ref, style, isDragging, isOver, attributes, listeners } = useSortableItem(id);

  return (
    <li
      ref={ref}
      style={style}
      {...attributes}
      {...listeners}
      data-nav-row={id}
      data-tab={narrow ? id : undefined}
      onClick={() => onToggle(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); } }}
      /* 被拖的那一格**整个藏起来**（浮层里那份实体卡跟着手指走），原位不留
         淡影 —— 留了就是「虚影锁定在原位」。占位虚影由 `isOver` 那一格画。 */
      className={cx('nav-chip cursor-grab', CHIP_CX, chipTone(on),
        isDragging && 'opacity-0', isOver && 'drag-land')}
    >
      <NavChipBody id={id} on={on} />
    </li>
  );
}

export { NavCard };
