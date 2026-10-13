/**
 * cal.ts —— 日程集相关
 */

import { canManage, type Cal } from '../types/types.ts';

/**
 * **谁是默认日程集** —— 界面与 `store` 都只问这一个函数，不各写一套判断。
 *
 * 三步，顺序有意义：
 *   1. 用户选过、且那个集我还在里面 → 就是它（哪怕我是只读成员：我可以把它
 *      设成「打开时看哪个」，只是不能改它）。
 *   2. 选过的那个已经没了（被踢、被删、我退出了）→ 退到**第一个自己建的集**。
 *      不退到「列表第一个」是因为列表顺序按 `createdAt`，可能第一个是别人
 *      建、我只有只读的集 —— 把它当默认没有意义，而且它多半不能改名。
 *   3. 一个自己建的都没有（只有别人拉我进去的集）→ 列表第一个。此时**不要**
 *      硬造一个默认出来：这一栏会显示成「星标在别人建的集上」，而那一栏还
 *      带着「不能删」的暗示。
 *
 * 返回 null = 一个集都没有（还没连上服务器 / 注册刚落地）。
 */
export function resolveDefaultCal(ui: Pick<import('../types/types.ts').UiPrefs, 'defaultCal'>, cals: Cal[]): string | null {
  if (ui.defaultCal && cals.some((c) => c.id === ui.defaultCal)) return ui.defaultCal;
  const own = cals.find((c) => canManage(c.role));
  if (own) return own.id;
  return cals.length ? cals[0].id : null;
}
