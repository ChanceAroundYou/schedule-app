/**
 * ai.test.ts —— SSE 切分与工具文案（node:test，零依赖）
 *
 * 这里证的是两件「写错了不会报错、只会偶尔少一句话」的事：
 * 网络把一个事件切在两个 chunk 中间，以及工具名到中文的映射。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sseFeed, actionText, buildContext, applyEvent, newLiveAssistant, proposalText,
} from './ai.ts';
import type { LocalState, Cal } from './types.ts';

/* ------------------------------------------------------------ SSE 切分 */

test('一个 chunk 里有好几个事件', () => {
  const wire =
    'data: {"type":"session","sessionId":"s1"}\n\n'
    + 'data: {"type":"text","delta":"你"}\n\n'
    + 'data: {"type":"text","delta":"好"}\n\n';

  const { events, rest } = sseFeed(wire);
  assert.equal(rest, '');
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'text']);
  assert.equal(events[2].type === 'text' && events[2].delta, '好');
});

test('事件被切在两个 chunk 中间 —— 剩下的必须留下来', () => {
  // 这是最容易漏的一步：不留 rest 就是「每个 chunk 边界上丢一个事件」，
  // 而现象只是「偶尔少一句话」，看日志看不出来。
  const a = 'data: {"type":"text","delta":"前半"}\n\ndata: {"type":"text","del';
  const first = sseFeed(a);
  assert.equal(first.events.length, 1);
  assert.ok(first.rest.startsWith('data: {"type":"text","del'), '没把半截留下');

  const second = sseFeed(first.rest + 'ta":"后半"}\n\n');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].type === 'text' && second.events[0].delta, '后半');
  assert.equal(second.rest, '');
});

test('一个 chunk 连半个事件都没有时不吐出任何东西', () => {
  const { events, rest } = sseFeed('data: {"type":"text"');
  assert.deepEqual(events, []);
  assert.equal(rest, 'data: {"type":"text"');
});

test('坏事件只丢那一条，后面的照收', () => {
  const wire =
    'data: {这不是 JSON}\n\n'
    + 'data: {"type":"text","delta":"还在"}\n\n';

  const { events } = sseFeed(wire);
  assert.equal(events.length, 1, '一条坏行不该把整条流带走');
  assert.equal(events[0].type === 'text' && events[0].delta, '还在');
});

test('注释行、非 data 字段、缺 type 的都被跳过', () => {
  const wire =
    ': 这是一条注释\n'
    + 'event: ping\n'
    + 'data: {"noType":true}\n\n'
    + 'data: {"type":"done"}\n\n';

  const { events } = sseFeed(wire);
  assert.deepEqual(events.map((e) => e.type), ['done']);
});

/* ---------------------------------------------------------- 工具文案 */

test('工具名翻成中文，认不出的原样显示', () => {
  assert.equal(actionText('list_tasks', { from: '2026-10-07', to: '2026-10-09' }), '查 10月7日–10月9日 的安排');
  assert.equal(actionText('list_tasks', { from: '2026-10-07', to: '2026-10-07' }), '查 10月7日 的安排');
  assert.equal(actionText('list_tasks', {}), '查安排');
  assert.equal(actionText('search_tasks', { query: '电费' }), '搜「电费」');
  assert.equal(actionText('free_slots', { from: '2026-10-07' }), '找 10月7日 的空档');
  // 后端加了新工具而前端还没跟上时，冒个英文名也比冒个空白条强
  assert.equal(actionText('brand_new_tool'), 'brand_new_tool');
});

test('参数不是字符串时不出丑', () => {
  // 模型的参数是它自己给的，什么类型都可能来
  assert.equal(actionText('list_tasks', { from: 123 }), '查安排');
  assert.equal(actionText('load_summary'), '算忙闲');
});

/* ------------------------------------------------------------ 上下文 */

test('上下文带上当前看的集，集不在时就不带', () => {
  const cal: Cal = { id: 'c1', name: '家庭', ownerId: 'u', createdAt: 0, role: 'owner' };
  const state = {
    cals: [cal],
    ui: { nav: 'ai', view: 'week', cursor: '2026-10-08', cal: 'c1' },
  } as unknown as LocalState;

  const ctx = buildContext(state);
  assert.equal(ctx.calId, 'c1');
  assert.equal(ctx.calName, '家庭');
  assert.equal(ctx.nav, 'ai');
  assert.equal(ctx.view, 'week');
  assert.equal(ctx.cursor, '2026-10-08');
  assert.match(String(ctx.today), /^\d{4}-\d{2}-\d{2}$/);

  // 选中的集被移出 / 还没同步回来时，别硬塞一个 undefined 进去
  const none = buildContext({ ...state, cals: [], ui: { ...state.ui, cal: 'c1' } } as LocalState);
  assert.ok(!('calId' in none));
  assert.ok(!('calName' in none));
});

/* ---------------------------------------------------------- 事件并入 */

test('文字是追加的，动作条按下标同位配对', () => {
  let live = newLiveAssistant('m1');
  live = applyEvent(live, { type: 'text', delta: '看' });
  live = applyEvent(live, { type: 'text', delta: '了' });
  assert.equal(live.text, '看了');

  live = applyEvent(live, { type: 'tool', phase: 'start', name: 'list_tasks', args: { from: '2026-10-07' } });
  assert.deepEqual(live.actions, [{ name: 'list_tasks', label: '查 10月7日 的安排', done: false }]);

  live = applyEvent(live, { type: 'tool', phase: 'end', name: 'list_tasks', isError: false });
  assert.equal(live.actions[0].done, true);
  assert.equal(live.actions[0].error, false);
});

test('同一个工具被调两次也能各配各的', () => {
  // 模型经常连着查两次（先看本周再看下周），按下标配对会串
  let live = newLiveAssistant('m1');
  live = applyEvent(live, { type: 'tool', phase: 'start', name: 'free_slots', args: { from: '2026-10-07' } });
  live = applyEvent(live, { type: 'tool', phase: 'end', name: 'free_slots' });
  live = applyEvent(live, { type: 'tool', phase: 'start', name: 'free_slots', args: { from: '2026-10-14' } });

  assert.deepEqual(live.actions.map((a) => a.done), [true, false]);

  live = applyEvent(live, { type: 'tool', phase: 'end', name: 'free_slots' });
  assert.deepEqual(live.actions.map((a) => a.done), [true, true]);
});

test('error 事件落在气泡上，session / done 不改变气泡', () => {
  const live = newLiveAssistant('m1');
  const after = applyEvent(live, { type: 'error', message: '连不上模型服务', code: 'model' });
  assert.equal(after.error, '连不上模型服务');

  // session / done 是会话级的东西，不该混进这条气泡的内容里
  assert.equal(applyEvent(live, { type: 'session', sessionId: 's1' }), live);
  assert.equal(applyEvent(live, { type: 'done' }), live);
});

/* ------------------------------------------------ 提案：卡片上那句话 */

test('写入工具名翻成「还没发生」的动词', () => {
  assert.equal(actionText('create_task', { title: '给奶奶买降压药' }), '建「给奶奶买降压药」');
  assert.equal(actionText('create_task', {}), '建一条任务');
  assert.equal(actionText('update_task', {}), '改一条任务');
  assert.equal(actionText('complete_task', { done: true }), '标完成');
  assert.equal(actionText('complete_task', { done: false }), '改回没做');
  assert.equal(actionText('reschedule_task', {}), '改期');
  assert.equal(actionText('delete_task', {}), '删一条任务');
});

test('提案翻成人话，说的是「打算」而不是「已经」', () => {
  const base = { id: 'c1', kind: 'create', calId: 'cal', entity: 'task', entityId: 't1', title: '给奶奶买降压药' };

  assert.equal(
    proposalText({ ...base, fields: { title: '给奶奶买降压药', date: '2026-10-08', time: '14:00' } }),
    '新建「给奶奶买降压药」 · 10月8日 14:00',
  );
  // 没定日期 = 待办箱，得说出来，不能只写个「新建」
  assert.equal(
    proposalText({ ...base, title: '买菜', fields: { title: '买菜', date: null } }),
    '新建「买菜」',
  );
  assert.equal(
    proposalText({ ...base, title: '买菜', fields: { title: '买菜', date: '2026-10-08' } }),
    '新建「买菜」 · 10月8日（不定时）',
  );

  assert.equal(
    proposalText({ ...base, kind: 'reschedule', fields: { date: '2026-10-09', time: '15:00' } }),
    '「给奶奶买降压药」改期到 10月9日 15:00',
  );
  assert.equal(
    proposalText({ ...base, kind: 'complete', fields: { done: true, doneAt: 1 } }),
    '把「给奶奶买降压药」标成做完',
  );
  assert.equal(
    proposalText({ ...base, kind: 'uncomplete', fields: { done: false, doneAt: null } }),
    '把「给奶奶买降压药」改回没做',
  );
  assert.equal(
    proposalText({ ...base, kind: 'delete', fields: { deleted: true, trashFrom: 'AI' } }),
    '删掉「给奶奶买降压药」（会进垃圾箱）',
  );
});

test('update 的提案只列真改了的字段，实现细节不印出来', () => {
  const p = {
    id: 'c2', kind: 'update', calId: 'cal', entity: 'task', entityId: 't2', title: '交房租',
    fields: { title: '交房租（转账）', date: '2026-10-09', order: null, trashFrom: 'AI', doneAt: 1 },
  };
  const s = proposalText(p);
  assert.match(s, /改「交房租」/);
  assert.match(s, /标题 → 交房租（转账）/);
  assert.match(s, /日期 → 10月9日/);
  // order / trashFrom / doneAt 是实现细节，印出来用户只会看到看不懂的行
  assert.ok(!s.includes('order'), '把 order 印出来了');
  assert.ok(!s.includes('trashFrom'), '把 trashFrom 印出来了');
  assert.ok(!s.includes('doneAt'), '把 doneAt 印出来了');
});

test('提案按 id 去重，重复的流事件不冒第二张卡片', () => {
  const live = newLiveAssistant('m1');
  const p = { id: 'c1', kind: 'create', calId: 'cal', entity: 'task', entityId: 't1', title: 'x', fields: {} };
  const once = applyEvent(live, { type: 'proposal', proposal: p });
  assert.equal(once.proposals.length, 1);
  assert.equal(applyEvent(once, { type: 'proposal', proposal: p }), once, '同一条提案来了两次');
});
