/**
 * constants.test.ts —— 同步引擎那几个数字，以及它们和服务器之间的默契
 *
 * 常量本身没什么好测的，值得测的是**跨层的后果**：
 *   `OPS_PER_CALL`（客户端一批）必须 ≤ `MAX_OPS`（服务端一次收多少）。
 *   超了的后果不是「慢一点」：服务端对整批返回 `bad_request`，而客户端把
 *   `bad_request` 当终态处理 —— 那条 opId 是空串，一条都清不掉，于是发件箱
 *   每一轮都被整批退回，**改动永远推不上去，而且界面上连一句话都没有**
 *   （只有 clock / forbidden 两种会说给用户听）。
 *   这条不变量两边各写各的、谁都不会自然想起对方，所以只能靠测试钉住。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OPS_PER_CALL, MAX_ROUNDS, PUSH_DEBOUNCE_MS, POLL_MS } from './constants.ts';

/* 服务端的上限从服务端拿，不在这里再抄一遍数字（抄的那份不会跟着改）。
   ⚠️ `@ts-expect-error`：`server/lib/sync.js` 是 CommonJS 且没有类型声明，
   tsc 认不出它；运行时 import 是好的（`db.open(dir)` 是显式调用的，
   光是 import 这个模块不会碰任何数据库文件）。 */
// @ts-expect-error 没有 .d.ts，运行时可用（MAX_PULL 没导出，客户端也用不上）
const { MAX_OPS } = await import('../../../server/lib/sync.js');

test('客户端一批 500 条必须小于服务端一次能收的条数', () => {
  assert.ok(OPS_PER_CALL <= (MAX_OPS as number),
    `OPS_PER_CALL ${OPS_PER_CALL} > 服务端 MAX_OPS ${MAX_OPS}：整批会被退回 bad_request，`
    + '而客户端把 bad_request 当终态 —— 发件箱每一轮都被拒、改动永远推不上去，界面上还不会有提示');
});

test('一次 syncNow 至少能清空服务端一批的量级（推不完也得能在几次触发内清干净）', () => {
  assert.ok(MAX_ROUNDS * OPS_PER_CALL >= (MAX_OPS as number),
    `MAX_ROUNDS ${MAX_ROUNDS} × OPS_PER_CALL ${OPS_PER_CALL} 连服务端一批（${MAX_OPS}）都消化不掉的话，`
    + '积压的改动要等下一次触发才动得了');
  assert.ok(MAX_ROUNDS >= 2, '只允许一轮就没有「接着推」这回事了');
});

test('攒批窗口比兜底轮询短（否则「连续操作只发一次请求」是空话：轮询会先把它推掉）', () => {
  assert.ok(PUSH_DEBOUNCE_MS < POLL_MS,
    `${PUSH_DEBOUNCE_MS}ms 的攒批窗口必须短于 ${POLL_MS}ms 的轮询`);
  assert.ok(PUSH_DEBOUNCE_MS > 0 && POLL_MS > 0, '都是正数（写成 0 就是每次改动各发一趟）');
});

test('不只是「不超过」，还要留足余量（`constants.ts` 里写的是「留出余量分批」）', () => {
  assert.ok(OPS_PER_CALL * 2 <= (MAX_OPS as number),
    `OPS_PER_CALL ${OPS_PER_CALL} 对服务端上限 ${MAX_OPS} 只够一半都不到的话，`
    + '哪天上限调小或有人改大批量，就会正好压在线上（压线的那条路是整批被拒）');
});
