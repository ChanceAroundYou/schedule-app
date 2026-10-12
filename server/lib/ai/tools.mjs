/**
 * ai/tools.mjs —— AI 的操作接口（本体）**的桶文件**
 *
 * 这就是用户要的「给 AI 留出操作的接口」。实现拆在同目录的四个文件里，
 * 这里只 re-export —— **`import { allTools } from './tools.mjs'` 一行都不用改**。
 *
 *   read.mjs     只读工具：直接执行，结果喂回模型。
 *   write.mjs    写入工具：**不执行**，只产出一张待用户确认的提案。
 *                真的落库在 `lib/ai/confirm.js`，那里会重查一遍权限。
 *   memory.mjs   记忆工具：唯一不需要确认的写工具。
 *   shared.mjs   上限常量与共用件（数据一律经 `sync.snapshot()` 拿，见其文件头）。
 *
 * ## 两条不许破的规矩
 *
 * 1. **数据一律从 `sync.snapshot(userId)` 拿，绝不自己写 SQL 查 `field_state`。**
 *    snapshot 已经按 `calendarIdsFor(userId)` 过滤过、已经剔掉墓碑。自己写一条
 *    SQL，权限过滤迟早漏一处 —— 那就成了「只读成员能通过 AI 看见别人的集」。
 *
 * 2. **工具的返回是给模型看的，不是给程序看的。** 字段名用中文语义、时间用
 *    `HH:MM`、日期用 `YYYY-MM-DD`、去掉 `_ts` / `_dev` 这类内部字段。
 *
 * 工具名与参数名保持英文：模型对 `list_tasks({from,to})` 这种形状的调用最稳，
 * 而描述用中文，回答才会跟着说中文。
 *
 * `allTools()` 是完整的工具集；只读那半边可以单独取 `readTools()`
 * （阶段 2 的用例只挂只读的 —— 先把「模型能不能正确调到工具、参数对不对」
 * 解决掉，再引入写路径，两件事混在一起时出问题分不清是工具层还是权限层）。
 */
import { readTools, READ_TOOL_NAMES } from './tools/read.mjs';
import { writeTools, WRITE_TOOL_NAMES } from './tools/write.mjs';
import { memoryTools } from './tools/memory.mjs';

export { readTools, writeTools, memoryTools, READ_TOOL_NAMES, WRITE_TOOL_NAMES };

export function allTools({ userId, proposals }) {
  return [...readTools({ userId }), ...writeTools({ userId, proposals }), ...memoryTools({ userId })];
}