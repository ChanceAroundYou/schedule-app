/**
 * app/pickDate.ts —— 行内「改到…」：一个离屏的 `<input type="date">`
 *
 * 为什么不用现成的日期选择器浮层：这一格只有「某一行」一个上下文，浮层要
 * 记它属于哪一行、要处理焦点与关闭顺序；原生 input 配合 `showPicker()` 直接
 * 弹系统日历 —— **手机上还是用户自己熟悉的那个**。
 *
 * 那个 input 被 `position:fixed` 挪到屏幕外，是**故意**的：它只是为了拿到
 * 系统日期面板和 `change` 事件，不能被看见，也不能被 Tab 进去
 * （它没有可访问名字，混进 Tab 序列里会是个空读屏）。
 *
 * **60 秒的兜底 remove 不能省**：`showPicker()` 被取消时不一定有 `change`
 * 事件，input 会一直挂在 body 上。
 */
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';
import { toast } from '../ui/kit.tsx';

export function pickDate(id: string): void {
  const inp = document.createElement('input');
  inp.type = 'date';
  inp.style.cssText = 'position:fixed;left:-9999px;top:0';
  inp.value = store.get().tasks[id]?.date || D.today();
  document.body.appendChild(inp);
  inp.addEventListener('change', () => {
    if (inp.value) {
      store.patchTask(id, { date: inp.value });
      toast('已改到 ' + D.fmtMD(inp.value));
    }
  });
  setTimeout(() => inp.remove(), 60000);
  const p = inp as HTMLInputElement & { showPicker?: () => void };
  if (typeof p.showPicker === 'function') p.showPicker();
  else inp.click();   // 老 WebView 没有 showPicker，退化成点击（input 在屏幕外，只能靠这个）
}
