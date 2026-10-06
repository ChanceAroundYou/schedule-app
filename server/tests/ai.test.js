/**
 * ai.test.js —— AI 这一层：工具循环、SSE 事件、会话落库
 *
 *   node --test server/tests/ai.test.js
 *
 * **全程用假模型**（pi-ai 自带的 `createFauxCore`，不用手搓）：按剧本先吐一个
 * tool_call、再吐最终文本。于是「模型能不能正确调到工具、参数对不对、事件序列
 * 稳不稳」全都可测，**不联网、不烧额度、结果稳定**。
 *
 * 单独一个文件：api.test.js 全程占着 db 那个单例，node --test 每个文件一个进程，
 * 正好把库隔离掉。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../lib/db');
const sync = require('../lib/sync');
const aiSettings = require('../lib/ai/settings');
const ai = require('../lib/ai');

/* ------------------------------------------------------------------ 环境 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-ai-'));
db.open(dir);

const USER = 'u-ai';
const CAL = 'cal-ai';

db.insertUser({ id: USER, name: '爸爸', salt: 's', hash: 'h', createdAt: 1000 });
db.insertCalendar({ id: CAL, name: '我的日程', ownerId: USER, createdAt: 1000 });
db.upsertMember(CAL, USER, 'owner');

/** 造一条任务。走 applyOps，和真客户端同一条路 */
let seq = 0;
function seed(entityId, fields, calId = CAL) {
  seq += 1;
  const r = sync.applyOps(USER, [{
    opId: `op-${seq}`,
    deviceId: 'devA',
    calId,
    entity: 'task',
    entityId,
    ts: Date.now() + seq,
    // fields 传的是**原始值**，不是 JSON 串：applyOps 自己会 JSON.stringify。
    // 传 `'买菜'` 进来会被二次编码，读出来是带引号的字面量 `"买菜"` ——
    // 日期这么写的话字符串比较全错，任务会诡异地落进 overdue。
    fields,
  }]);
  assert.deepStrictEqual(r.rejected, [], `造数据被拒：${JSON.stringify(r.rejected)}`);
}

/** 相对今天的日期，让断言不随日历漂移 */
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- 假模型 */

let _pi = null;
async function loadPi() {
  if (!_pi) _pi = await import('@earendil-works/pi-ai');
  return _pi;
}

/**
 * 按剧本造一个假模型。pi-ai 自带 faux provider，不用手搓。
 * @param {Array<object|Function>} steps 每一步返回一条 assistant 消息
 */
async function scripted(steps) {
  const pi = await loadPi();
  const faux = pi.createFauxCore({});
  faux.setResponses(steps);
  return { faux, streamFn: faux.streamSimple };
}

/** 收集 emit 出来的事件 */
function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e), types: () => events.map((e) => e.type) };
}

/* ---------------------------------------------------------------- 用例 */

test('一轮对话：模型调 list_tasks，拿到的结果里真有库里的任务', async () => {
  seed('t-1', { title: '开家长会', date: `${day(1)}`, time: '14:00', duration: 90 });
  seed('t-2', { title: '买菜', date: `${day(1)}`, done: true });

  const pi = await loadPi();
  const seen = [];
  const { streamFn } = await scripted([
    pi.fauxAssistantMessage(
      [pi.fauxToolCall('list_tasks', { from: day(1), to: day(1) })],
      { stopReason: 'toolUse' },
    ),
    (ctx) => {
      // 把模型第二次看到的上下文留下来 —— 这一条断言的是「工具结果真的回喂了」
      seen.push(JSON.stringify(ctx.messages));
      return pi.fauxAssistantMessage('那天只有开家长会，下午两点。');
    },
  ]);

  const c = collector();
  await ai.load().then((m) => m.runChat({
    userId: USER,
    text: '明天有什么事',
    emit: c.emit,
    streamFn,
  }));

  assert.deepStrictEqual(
    c.types().filter((t) => t === 'tool'),
    ['tool', 'tool'],
    `事件序列不对：${JSON.stringify(c.types())}`,
  );
  const start = c.events.find((e) => e.type === 'tool' && e.phase === 'start');
  assert.strictEqual(start.name, 'list_tasks');
  assert.strictEqual(start.args.from, day(1));

  const done = c.events.find((e) => e.type === 'tool' && e.phase === 'end');
  assert.strictEqual(done.isError, false);
  assert.match(done.summary, /开家长会/, '工具结果里没有那条任务');

  // 已完成的默认不出现在 list_tasks 里 —— 与前端 liveTasks 的口径一致
  assert.ok(!done.summary.includes('买菜'), '默认不该带出已完成的任务');

  assert.ok(seen[0].includes('开家长会'), '工具结果没有回喂给模型');
  assert.ok(c.types().includes('text'), '没有收到流式的文字');
  assert.strictEqual(c.types().at(-1), 'done');
  assert.ok(c.events.find((e) => e.type === 'session').sessionId);
});

test('工具参数非法时给的是 isError，不是崩掉', async () => {
  const pi = await loadPi();
  const { streamFn } = await scripted([
    pi.fauxAssistantMessage(
      [pi.fauxToolCall('list_tasks', { from: '不是日期' })],
      { stopReason: 'toolUse' },
    ),
    pi.fauxAssistantMessage('日期没看懂。'),
  ]);

  const c = collector();
  await ai.load().then((m) => m.runChat({
    userId: USER, text: '看看', emit: c.emit, streamFn,
  }));

  const done = c.events.find((e) => e.type === 'tool' && e.phase === 'end');
  assert.strictEqual(done.isError, true, '非法参数应当作为错误结果回给模型');
  assert.match(done.summary, /from 不是/);
});

test('对话落库：用户那句话也在，刷新之后还读得到', async () => {
  const pi = await loadPi();
  const { streamFn } = await scripted([pi.fauxAssistantMessage('在的。')]);

  const c = collector();
  const mod = await ai.load();
  await mod.runChat({ userId: USER, text: '记一下：周五体检', emit: c.emit, streamFn });

  const sid = c.events.find((e) => e.type === 'session').sessionId;
  const row = db.findAiSession(sid, USER);
  assert.ok(row, '会话没落库');

  const msgs = db.listAiMessages(sid, USER);
  assert.strictEqual(msgs.length, 2, '应当正好是「用户一条 + 助手一条」');
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.ok(msgs[0].seq < msgs[1].seq, 'seq 必须是递增的');

  // 标题取第一句话的前几个字，列表里认得出是哪次对话
  assert.match(row.title, /记一下/);
  assert.ok(!msgs.some((m) => m.role === 'system'), '系统提示词不该落库（它每轮都会重算）');

  // 再问一轮：历史要带进去，否则模型每次都是从零开始
  const seen = [];
  const s2 = await scripted([(ctx) => {
    seen.push(JSON.stringify(ctx.messages));
    return pi.fauxAssistantMessage('好。');
  }]);
  await mod.runChat({ userId: USER, sessionId: sid, text: '几点来着', emit: collector().emit, streamFn: s2.streamFn });

  assert.ok(seen[0].includes('记一下：周五体检'), '同一会话的第二轮没带上历史');
  assert.ok(seen[0].includes('在的。'));
  assert.strictEqual(db.listAiMessages(sid, USER).length, 4);
});

test('上游出错时要说出来（pi 是写成消息，不是抛异常）', async () => {
  // 这一条是端到端跑真网关才发现的：pi **不抛**，它把错误写成一条
  // `stopReason: 'error'` 的 assistant 消息。只靠 try/catch 的话，
  // 上游 401 / 连不上 / 没填 key 全都表现成「模型回了一句空话」，
  // 界面上是一片空白，日志里干干净净。
  const pi = await loadPi();
  const { streamFn } = await scripted([
    pi.fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'No API key for provider: openai-completions' }),
  ]);

  const c = collector();
  await ai.load().then((m) => m.runChat({
    userId: USER, text: '在吗', emit: c.emit, streamFn,
  }));

  const err = c.events.find((e) => e.type === 'error');
  assert.ok(err, `没有报错事件：${JSON.stringify(c.types())}`);
  assert.match(err.message, /API key/, '错误没有翻成人话');
  assert.strictEqual(c.types().at(-1), 'done', '出错也要正常收尾，别让前端一直转');

  // 而且那条空消息不能进历史 —— 否则下次打开会看到一只永久空白的空气泡
  const sid = c.events.find((e) => e.type === 'session').sessionId;
  const msgs = db.listAiMessages(sid, USER);
  assert.ok(!msgs.some((m) => m.role === 'assistant'), `空了的气泡被存下来了：${JSON.stringify(msgs)}`);
  assert.strictEqual(msgs.length, 1, '只该留下用户那一句');
});

test('别人的会话读不到、删不掉', async () => {
  db.insertUser({ id: 'u-other', name: '妈妈', salt: 's', hash: 'h', createdAt: 1000 });
  const pi = await loadPi();
  const { streamFn } = await scripted([pi.fauxAssistantMessage('嗯。')]);
  const mod = await ai.load();

  const c = collector();
  await mod.runChat({ userId: USER, text: '这是爸爸的对话', emit: c.emit, streamFn });
  const sid = c.events.find((e) => e.type === 'session').sessionId;

  const sessions = require('../lib/ai/sessions');
  assert.strictEqual(sessions.one('u-other', sid).status, 404, '别人的会话不能读');
  assert.strictEqual(sessions.remove('u-other', sid).status, 404, '别人的会话不能删');
  assert.ok(db.findAiSession(sid, USER), '而且不能被删掉');
});

/* ------------------------------------------------- 只读工具本身的口径 */

test('load_summary 的口径与前端 dayLoad 一致', async () => {
  // 这一条对应前端 domain/model.ts 的 dayLoad：跳过已完成、跳过别的日期，
  // 只有定了时间的才累加 duration（默认 60）。两边算得不一样的话，
  // 界面上写着「3 小时」而 AI 说「那天很空」。
  const d = day(3);
  seed('s-1', { title: '甲', date: `${d}`, time: '09:00', duration: 30 });
  seed('s-2', { title: '乙', date: `${d}`, time: '10:00' });              // 默认 60 分钟
  seed('s-3', { title: '丙', date: `${d}` });                               // 未定时，只计数
  seed('s-4', { title: '丁', date: `${d}`, time: '11:00', done: true });  // 已完成，不算

  const tools = await import('../lib/ai/tools.mjs');
  const t = tools.readTools({ userId: USER }).find((x) => x.name === 'load_summary');
  const r = await t.execute('c1', { from: d, to: d });
  const got = r.details.days[0];

  assert.strictEqual(got.count, 3, `条数不对：${JSON.stringify(got)}`);
  assert.strictEqual(got.mins, 90, `分钟数不对：${JSON.stringify(got)}`);
});

test('free_slots：已完成的任务不再占时间', async () => {
  const d = day(4);
  // 整天 08:00–22:00 都被一条**已完成**的任务占着
  seed('f-1', {
    title: '早就做完了', date: `${d}`, time: '08:00', duration: 14 * 60, done: true,
  });
  // 再来一条没做完的，占 10:00–11:00
  seed('f-2', { title: '还没做', date: `${d}`, time: '10:00', duration: 60 });

  const tools = await import('../lib/ai/tools.mjs');
  const t = tools.readTools({ userId: USER }).find((x) => x.name === 'free_slots');
  const r = await t.execute('c1', { from: d, to: d, minMinutes: 60 });
  const got = r.details.days[0];

  const spans = got.free.map((g) => `${g.start}-${g.end}`);
  assert.deepStrictEqual(spans, ['08:00-10:00', '11:00-22:00'],
    `空档不对：${JSON.stringify(spans)}（已完成的 08:00–22:00 不该继续占着）`);
  assert.strictEqual(got.busyMinutes, 60, '只算未完成的那条（10:00–11:00）');
});

test('search_tasks 在标题和备注里找，且看不见的集搜不到', async () => {
  db.insertUser({ id: 'u-x', name: '路人', salt: 's', hash: 'h', createdAt: 1000 });
  db.insertCalendar({ id: 'cal-x', name: '别人的集', ownerId: 'u-x', createdAt: 1000 });
  db.upsertMember('cal-x', 'u-x', 'owner');
  sync.applyOps('u-x', [{
    opId: 'x-1', deviceId: 'devX', calId: 'cal-x', entity: 'task', entityId: 'x-1',
    ts: Date.now(), fields: { title: '邻居家的秘密', date: `${day(5)}` },
  }]);

  seed('q-1', { title: '交电费', note: '支付宝里那个', date: `${day(5)}` });

  const tools = await import('../lib/ai/tools.mjs');
  const t = tools.readTools({ userId: USER }).find((x) => x.name === 'search_tasks');

  const hit = await t.execute('c1', { query: '电费' });
  assert.strictEqual(hit.details.total, 1);
  assert.match(hit.details.tasks[0].title, /交电费/);

  const byNote = await t.execute('c2', { query: '支付宝' });
  assert.strictEqual(byNote.details.total, 1, '备注也要能搜到');

  const leak = await t.execute('c3', { query: '邻居家的秘密' });
  assert.strictEqual(leak.details.total, 0, '搜到了别人集里的任务 —— 权限过滤漏了');
});
