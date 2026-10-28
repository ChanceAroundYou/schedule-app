/**
 * rejected.test.ts —— 服务器退回的 op 怎么处理
 *
 * 三种退回必须分开对待，混一起就出事（`rejected.ts` 的头注释写了为什么）：
 *   bad_request / forbidden —— 终态，**丢掉**。留在 outbox 最前面会永远堵着，
 *                 后面每条改动都推不上去；forbidden 留着的另一层危险是
 *                 「哪天被重新授权，一条几个月前的改动突然生效」。
 *   clock       —— 只是本机表不对，**必须留着**。丢掉等于用户那几次操作凭空消失。
 *
 * 这一轮之前 `src/sync/` 一条单测都没有（package.json 里那个 glob 匹配不到任何文件），
 * 所以上面这三条全靠肉眼守着。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshStore, CAL } from './testenv.ts';

const store = await import('../data/store.ts');
const { handleRejected } = await import('./rejected.ts');

/** 往发件箱里压 n 条改动，返回它们的 opId（顺序就是将来推送的顺序） */
function seedOps(n: number): string[] {
  store.commitMany(Array.from({ length: n }, (_, i) => ({
    entity: 'task' as const, id: `t${i}`, calId: CAL,
    fields: { title: `任务 ${i}`, date: null },
  })));
  return store.get().outbox.map((o) => o.opId);
}

test('bad_request 丢掉：它重试多少次都一样，留着会堵死整条队列', () => {
  freshStore();
  const ids = seedOps(3);
  handleRejected([{ opId: ids[0], code: 'bad_request', reason: '字段不合法' }]);
  const left = store.get().outbox.map((o) => o.opId);
  assert.equal(left.length, 2, '坏的那一条必须离开 outbox');
  assert.ok(!left.includes(ids[0]));
  assert.deepEqual(left, [ids[1], ids[2]], '其余两条的顺序不许变（它们排在坏的后面，正因此才一直推不上去）');
});

test('forbidden 丢掉并且说出来（只读成员点了勾选，不能静默失败）', () => {
  freshStore();
  const ids = seedOps(2);
  handleRejected([{ opId: ids[1], code: 'forbidden', reason: '没有这个集的写权限' }]);
  assert.equal(store.get().outbox.length, 1);
  assert.match(store.get().lastError ?? '', /没有权限/);
  assert.match(store.get().lastError ?? '', /1 条/, '数量要说出来，用户才知道丢了几条');
});

test('clock 退回的留着：丢掉等于用户那几次操作凭空消失', () => {
  freshStore();
  const ids = seedOps(2);
  handleRejected([{ opId: ids[0], code: 'clock', reason: '设备时钟偏差超过 24 小时' }]);
  assert.equal(store.get().outbox.length, 2, '一条都不许丢 —— 表调准了要能自己补传');
  assert.deepEqual(store.get().clockBlocked, [ids[0]]);
  assert.match(store.get().lastError ?? '', /本机时间不准/);
  /* 数字说的是「被时间挡住的那几条」，不是 outbox 总数：另外那条好好的，
     混着报会让用户以为整箱改动都悬着。写测试时把这条期望写成了 2，当场红。 */
  assert.match(store.get().lastError ?? '', /1 条改动等时间校准/, '要说清「等一等就会自动补传」，不是「出错了」');
});

test('三种混在一批里：clock 留、其余丢，提示按 clock 说', () => {
  freshStore();
  const ids = seedOps(4);
  handleRejected([
    { opId: ids[0], code: 'bad_request', reason: 'x' },
    { opId: ids[1], code: 'clock', reason: 'x' },
    { opId: ids[2], code: 'forbidden', reason: 'x' },
  ]);
  assert.deepEqual(store.get().outbox.map((o) => o.opId), [ids[1], ids[3]]);
  assert.deepEqual(store.get().clockBlocked, [ids[1]]);
  /* 同一批里既有「时间不对」又有「没权限」时先说时间：
     另一条的措辞是「已跳过」，用户看了会以为这几条白丢了。 */
  assert.match(store.get().lastError ?? '', /本机时间不准/);
  assert.doesNotMatch(store.get().lastError ?? '', /已跳过/);
});

test('退回列表是空的、而本地还记着被时钟挡住的 → 清空它（表校准完了）', () => {
  freshStore();
  const ids = seedOps(1);
  handleRejected([{ opId: ids[0], code: 'clock', reason: 'x' }]);
  assert.equal(store.get().clockBlocked.length, 1);
  handleRejected([]);
  assert.deepEqual(store.get().clockBlocked, [], '不清空的话抽屉里会一直挂着那条已经过时的说明');
});

test('退回列表是空的、本地也没有时钟阻塞 → 不该凭空造出一个 clockBlocked', () => {
  freshStore();
  handleRejected([]);
  assert.deepEqual(store.get().clockBlocked, []);
  assert.equal(store.get().lastError, null);
});

test('只有 forbidden 时不许提「本机时间」—— 两套措辞不许互相顶包', () => {
  freshStore();
  const ids = seedOps(1);
  handleRejected([{ opId: ids[0], code: 'forbidden', reason: 'x' }]);
  assert.doesNotMatch(store.get().lastError ?? '', /时间/);
});
