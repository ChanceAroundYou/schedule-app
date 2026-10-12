/**
 * anchored.ts —— 浮层锚定定位：量 anchor + panel，算出 fixed 定位。
 *
 * 算式本身在 `domain/layout.ts` 的 `placePanel`（纯函数，有单测）；
 * 这个 hook 只负责「什么时候量、量谁、把结果摆回 state」。
 *
 * 为什么值得单独一个 hook：同一段算式原本逐字抄在 DatePicker / TimePicker /
 * WhenPop / useDrawer 四处，各自只有依赖数组不同 —— 改一处漏三处，
 * 而且漏的那处不报错，只是「这一个浮层位置不对」。
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { placePanel } from '../../domain/layout.ts';

/**
 * @param anchor 触发按钮（定位基准）
 * @param panel  浮层本体（量它自己的宽高）
/**
 * @param open   关着的时候不量、返回 null —— 别让浮层在左上角闪一帧
 * @param deps   调用方给的额外依赖（层高 / 月份变了要重量）
 */
export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  deps: readonly unknown[] = [],
): { top: number; left: number } | null {
  return useAnchoredPositionFrom(anchor.current, panel, open, deps);
}

/**
 * anchor 是**已经拿到的元素**（不是 ref）的版本 —— WhenPop 拿到的就是这种：
 * 它的 anchor 是横条上传下来的 `HTMLElement | null`。
 *
 * 不能把 `null` 包成一个假 ref 去凑上一个签名：那个假 ref 的 `.current` 恒为
 * null，于是「还没拿到 anchor」和「拿到了」在 hook 里分不出来，第一次量会
 * 白跑一趟。直接收元素本身，element 进了依赖数组，拿到就重跑。
 *
 * 主签名（收 ref）不是多余的 —— DatePicker / TimePicker / useDrawer 三个调用点
 * 都本来就有 ref。这里为一种签名加一个变体，比把三处改成「传元素 + 自己
 * 造个 ref」要小。
 */
export function useAnchoredPositionFrom(
  anchor: HTMLElement | null,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  deps: readonly unknown[] = [],
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor || !panel.current) { setPos(null); return; }
    const r = anchor.getBoundingClientRect();
    setPos(placePanel({
      anchor: { top: r.top, bottom: r.bottom, left: r.left },
      size: { w: panel.current.offsetWidth, h: panel.current.offsetHeight },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方给
  }, [open, anchor, panel, ...deps]);
  return pos;
}
