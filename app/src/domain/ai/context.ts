/**
 * context.ts —— 上下文构建
 */

import type { LocalState } from '../types/types.ts';
import * as D from '../date.ts';

/**
 * 告诉服务器「我正在看什么」。
 *
 * 这几样服务器**不知道**：它没有界面的概念。但模型需要它们才答得准 ——
 * 用户问「这周呢」，得知道「这周」是从哪一天算起的。
 *
 * 只带 id 和名字这类小东西，**不带任务内容**：内容模型自己会用工具查，
 * 而快照是随每次请求传的，塞进去只会让每条消息都拖着一份全量数据。
 */
export function buildContext(s: LocalState): Record<string, unknown> {
  const cal = s.cals.find((c: import('../types/types.ts').Cal) => c.id === s.ui.cal);
  const out: Record<string, unknown> = {
    today: D.today(),
    nav: s.ui.nav,
    view: s.ui.view,
    cursor: s.ui.cursor,
  };
  if (cal) { out.calId = cal.id; out.calName = cal.name; }
  return out;
}
