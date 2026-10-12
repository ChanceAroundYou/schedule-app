/**
 * CalSheet.tsx —— 移动端日程集多选弹窗
 */

import type { LocalState } from '../../domain/types.ts';
import { Sheet } from '../kit.tsx';
import { CalRow } from './CalRow.tsx';

/**
 * 移动端：「更多」抽屉里那个按钮点出来的**多选弹窗面板**。
 *
 * 窄屏侧栏是收起的，桌面那个下拉多选框根本不存在 —— 没有这个面板的话，
 * 手机上就没有任何地方能改「显示哪几个集」。
 */
export function CalSheet({ state, open, onClose }: {
  state: LocalState; open: boolean; onClose: () => void;
}) {
  const shown = state.ui.cals;
  return (
    <Sheet open={open} onClose={onClose} title="显示的日程集">
      <div className="flex flex-col gap-[2px]">
        {state.cals.map((c) => <CalRow key={c.id} c={c} on={shown.includes(c.id)} />)}
      </div>
    </Sheet>
  );
}
