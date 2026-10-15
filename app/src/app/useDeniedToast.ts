/**
 * app/useDeniedToast.ts —— 把「写权限被挡」这件事说出来
 *
 * 只读日程集里点勾选，写入会在 `store.commitMany()` 那一层被丢在门口
 * （见 AGENTS.md「二、权限」第三条）。**不提示的话用户看到的是「点了没反应」，
 * 会以为程序坏了** —— 静默失败是这一层最糟的输出。
 *
 * **要说清是哪个集**：今天 / 逾期 / 待办箱是跨集的，在「今天」里勾了一条别的集
 * 的任务时，一句「这个日程集你只有查看权限」只会让人以为是眼前这个集出了问题。
 *
 * 判断「变没变」用计数器（`state.denied`）而不是布尔量：布尔量从 true 变 false
 * 再变 true 是同一个值，第二次就再也触发不到了。计数器每次被挡都 +1。
 */
import { useEffect, useRef } from 'react';
import type { LocalState } from '../domain/types.ts';
import { toast } from '../ui/kit.tsx';

export function useDeniedToast(state: LocalState): void {
  const deniedRef = useRef(state.denied);
  useEffect(() => {
    if (state.denied === deniedRef.current) return;
    deniedRef.current = state.denied;

    const names = state.deniedCals
      .map((id) => state.cals.find((c) => c.id === id)?.name)
      .filter((n): n is string => !!n);

    if (!names.length) {
      // 集已经不在本地了（被移出 / 刚删掉）—— 说不出名字，就说行为
      toast('改动没有保存：这个日程集你没有写入权限');
      return;
    }
    toast(names.length === 1
      ? `改动没有保存：「${names[0]}」里你只有查看权限`
      : `改动没有保存：这几个日程集你只有查看权限 —— ${names.join('、')}`);
  }, [state.denied, state.deniedCals, state.cals]);
}