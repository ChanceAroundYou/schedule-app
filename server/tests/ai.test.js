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
/**
 * 造数据的时间戳：**从「一秒前」起算并严格递增**。
 *
 * 别写成 `Date.now() + seq`。seed 出来的是「早就在的数据」，时间戳就该在过去；
 * 写成未来是**时序竞态**：确认那一步用的是 `confirm.js` 里从 `Date.now()` 起算的
 * `nextTs()`，两者谁赢只取决于「seed 到确认之间隔了几毫秒」。`seq` 涨到 13 时
 * AI 那边实测只赢 5ms，机器快一点就判负 —— 表现是 `failed: []`（LWW 判负的 op
 * 也算 applied，见 sync.js:85）但字段没变，测试随机红。
 *
 * 严格递增是因为同毫秒的两条 op 比较键会完全相同，后一条白写。
 */
let seedTs = 0;
function nextSeedTs() {
  seedTs = Math.max(Date.now() - 1000, seedTs + 1);
  return seedTs;
}

function seed(entityId, fields, calId = CAL) {
  seq += 1;
  const r = sync.applyOps(USER, [{
    opId: `op-${seq}`,
    deviceId: 'devA',
    calId,
    entity: 'task',
    entityId,
    ts: nextSeedTs(),
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

/* ------------------------------------------------------- 写工具 / 提案闸门 */

const confirmLib = require('../lib/ai/confirm');

/**
 * 用假模型跑一轮，逼出模型提的那张提案。
 *
 * 不直接调 `writeTools` 是因为要的是**端到端**：模型调工具 → 工具记提案 →
 * SSE 推出来 → 落库挂在消息上。中间少了哪一段，真跑起来都会是空的。
 */
async function pendingProposal(args) {
  const pi = await loadPi();
  const { streamFn } = await scripted([
    pi.fauxAssistantMessage([pi.fauxToolCall(args.tool, args.at)], { stopReason: 'toolUse' }),
    pi.fauxAssistantMessage('先这样，确认一下。'),
  ]);
  const c = collector();
  await ai.load().then((m) => m.runChat({
    userId: USER,
    text: args.q,
    sessionId: args.sid,
    emit: c.emit,
    streamFn,
  }));
  const p = c.events.find((e) => e.type === 'proposal');
  assert.ok(p, `模型没提提案：${JSON.stringify(c.types())}`);
  assert.strictEqual(c.types().at(-1), 'done');
  return { proposal: p.proposal, sessionId: c.events.find((e) => e.type === 'session').sessionId };
}

test('写工具只造提案：模型调完，库里一行都没变', async () => {
  const before = Object.keys(sync.snapshot(USER).tasks).length;
  const { proposal, sessionId } = await pendingProposal({
    tool: 'create_task',
    at: { title: '给爷爷打电话', date: day(2), time: '10:00', calId: CAL },
    q: '明天上午给爷爷打个电话',
  });

  assert.strictEqual(proposal.kind, 'create');
  assert.strictEqual(proposal.title, '给爷爷打电话');
  assert.strictEqual(proposal.fields.time, '10:00');
  assert.strictEqual(proposal.calId, CAL);

  const tasks = sync.snapshot(USER).tasks;
  assert.strictEqual(Object.keys(tasks).length, before, '提案阶段就把任务建到库里了 —— 模型说了不算');
  assert.ok(!tasks[proposal.entityId], '提案 entityId 在库里查得到');

  // 提案要挂在那条 assistant 消息上，否则刷新之后卡片画不出来
  const msg = db.listAiMessages(sessionId, USER).find((m) => m.proposals);
  assert.ok(msg, '消息上没挂提案');
  const stored = JSON.parse(msg.proposals);
  assert.strictEqual(stored[0].id, proposal.id);
  assert.strictEqual(stored[0].entityId, proposal.entityId);
});

test('确认之后才真的写，而且写出来的是 deviceId=ai', async () => {
  const { proposal } = await pendingProposal({
    tool: 'create_task',
    at: { title: '交物业费', date: day(3), time: '09:00', calId: CAL },
    q: '后天早上交物业费',
  });
  assert.strictEqual(sync.snapshot(USER).tasks[proposal.entityId], undefined, '确认前不该有这条');

  const r = confirmLib.confirm(USER, [proposal.id]);
  assert.deepStrictEqual(r.body.failed, [], `确认被拒：${JSON.stringify(r.body.failed)}`);
  assert.strictEqual(r.body.done.length, 1);

  const t = sync.snapshot(USER).tasks[proposal.entityId];
  assert.ok(t, '确认完库里还是没有这条');
  assert.strictEqual(t.title, '交物业费');
  assert.strictEqual(t.source, 'ai', '来源没标成 AI');
  // AI 是「另一台设备」，所以它写的东西要带 _dev === 'ai' ——
  // 客户端据此显示「另一台设备也改过」，不能被特判掉
  assert.strictEqual(t._dev.title, 'ai', 'deviceId 没落到 _dev 上');

  // 确认掉的卡片要从消息里划掉，否则刷新一次它又回来
  const row = db.get('SELECT proposals FROM ai_messages WHERE proposals LIKE ? ORDER BY seq DESC LIMIT 1', `%${proposal.id}%`);
  const left = row && row.proposals ? JSON.parse(row.proposals) : [];
  assert.ok(!left.some((x) => x && x.id === proposal.id), '确认完了卡片还挂在消息上');

  // 再确认一次要被认出来，而不是当成新的改动
  const again = confirmLib.confirm(USER, [proposal.id]);
  assert.strictEqual(again.body.done.length, 0);
  assert.ok(again.body.failed[0].reason.length, '重复确认没给理由');
});

test('提案生成之后被降级，确认会被挡下（这一步的再校验不能省）', async () => {
  const { proposal } = await pendingProposal({
    tool: 'create_task',
    at: { title: '不该出现的那条', date: day(4), calId: CAL },
    q: '把明天的一条任务记上',
  });
  assert.strictEqual(sync.snapshot(USER).tasks[proposal.entityId], undefined);

  db.upsertMember(CAL, USER, 'viewer');   // 提案生成到确认之间，被降成了只读
  try {
    const r = confirmLib.confirm(USER, [proposal.id]);
    assert.strictEqual(r.body.done.length, 0, '只读了还能写进去 —— 再校验漏了');
    assert.match(r.body.failed[0].reason, /没有修改权限/);
    assert.strictEqual(
      sync.snapshot(USER).tasks[proposal.entityId], undefined,
      '权限挡住了却还是写进去了',
    );
  } finally {
    db.upsertMember(CAL, USER, 'owner');   // 还原，别污染后面的用例
  }
});

test('确认只认 id，参数回传不了、提案也改不动', async () => {
  const { proposal } = await pendingProposal({
    tool: 'create_task',
    at: { title: '原封不动', date: day(5), time: '14:00', calId: CAL },
    q: '周四下午记一条',
  });

  // 客户端塞了「要改什么」进来 —— 整条都不是字符串，当场被当成空的
  const sneaky = confirmLib.confirm(USER, [{
    id: proposal.id,
    fields: { title: '被改过' },
    calId: 'cal-别人的',
  }]);
  assert.strictEqual(sneaky.status, 400);
  assert.ok(sync.snapshot(USER).tasks[proposal.entityId] === undefined, '被塞了参数还写进去了');

  // 存下来的那份提案原封不动。按 rowid 取最后一条 —— seq 是**会话内**的序号，
  // 跨会话比大小会拿到别的对话的消息
  const row = db.get(
    'SELECT proposals FROM ai_messages WHERE proposals IS NOT NULL ORDER BY rowid DESC LIMIT 1',
  );
  const mine = JSON.parse(row.proposals).find((x) => x && x.id === proposal.id);
  assert.strictEqual(mine.fields.title, '原封不动', '提案里的参数被人改过');

  const r = confirmLib.confirm(USER, [proposal.id]);
  assert.strictEqual(r.body.done.length, 1);
  assert.strictEqual(sync.snapshot(USER).tasks[proposal.entityId].title, '原封不动');
});

test('别人的提案确认不了（user_id 那道条件不能省）', async () => {
  // u-other 是上面那个用例里已经建好的「妈妈」—— 名字在 users 表里是 UNIQUE 的，
  // 再插一个同名会直接撞约束
  const { proposal } = await pendingProposal({
    tool: 'create_task',
    at: { title: '只属于爸爸', date: day(6), calId: CAL },
    q: '周六记一条',
  });

  const r = confirmLib.confirm('u-other', [proposal.id]);
  assert.strictEqual(r.body.done.length, 0, '确认了别人的提案');
  assert.ok(!sync.snapshot('u-other').tasks[proposal.entityId], '还写进了别人的集');
  assert.strictEqual(sync.snapshot(USER).tasks[proposal.entityId], undefined);
});

test('删是软删除，垃圾箱那行写着「从 AI 删的」', async () => {
  seed('t-del', { title: '旧收据', date: day(7) });
  const { proposal } = await pendingProposal({
    tool: 'delete_task',
    at: { id: 't-del', calId: CAL },
    q: '把那条旧收据删了',
  });
  assert.ok(sync.snapshot(USER).tasks['t-del'], '提案阶段就删掉了');

  const r = confirmLib.confirm(USER, [proposal.id]);
  assert.deepStrictEqual(r.body.failed, []);
  assert.strictEqual(sync.snapshot(USER).tasks['t-del'], undefined, '墓碑没生效');

  const field = db.allFields([CAL]).find(
    (f) => f.entity_id === 't-del' && f.field === 'trashFrom',
  );
  assert.ok(field, '垃圾箱里看不到是从哪删的');
  assert.strictEqual(JSON.parse(field.value), 'AI');
});

test('update 只动传了的字段，没传的原样留着', async () => {
  seed('t-up', { title: '交房租', date: day(8), time: '10:00', duration: 30, note: '月初' });
  const { proposal } = await pendingProposal({
    tool: 'update_task',
    at: { id: 't-up', calId: CAL, title: '交房租（转账）' },
    q: '把交房租改一下标题',
  });
  // 只改标题，别的字段一个都不该动 —— 包括 order（它只在换日期时才清）
  assert.deepStrictEqual(Object.keys(proposal.fields), ['title']);

  const r = confirmLib.confirm(USER, [proposal.id]);
  assert.deepStrictEqual(r.body.failed, []);
  const t = sync.snapshot(USER).tasks['t-up'];
  assert.strictEqual(t.title, '交房租（转账）');
  assert.strictEqual(t.note, '月初', '没让改的备注被动了');
  assert.strictEqual(t.date, day(8), '没让改的日期被动了');
  assert.strictEqual(t.duration, 30, '没让改的时长被动了');
});

test('换日期会顺手清掉旧位次，否则未定时的排序会不稳', async () => {
  seed('t-ord', { title: '取快递', date: day(9), order: 7 });
  const { proposal } = await pendingProposal({
    tool: 'reschedule_task',
    at: { id: 't-ord', date: day(10), calId: CAL },
    q: '把取快递挪到明天',
  });
  assert.strictEqual(proposal.fields.order, null, '没清旧位次');
  assert.strictEqual(proposal.fields.date, day(10));

  assert.deepStrictEqual(confirmLib.confirm(USER, [proposal.id]).body.failed, []);
  const t = sync.snapshot(USER).tasks['t-ord'];
  assert.strictEqual(t.date, day(10));
  assert.strictEqual(t.order, null);
});

test('重复任务不能标完成 —— 那套推算在客户端里', async () => {
  seed('t-rep', {
    title: '每天跑步', date: day(1),
    repeat: { unit: 'day', n: 1, weekdays: [], monthday: 1, end: null },
  });
  const toolsMod = await import('../lib/ai/tools.mjs');
  const proposals = new Map();
  const t = toolsMod.writeTools({ userId: USER, proposals })
    .find((x) => x.name === 'complete_task');
  const res = await t.execute('tc-rep', { id: 't-rep', done: true });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /重复任务/);
  assert.strictEqual(proposals.size, 0, '被拒了却还是记了一张提案');
});

test('多条一起确认，同一毫秒里时间戳也要严格递增', async () => {
  // 两条 op 如果拿到同一个 (ts, deviceId)，LWW 判不出先后，后一条会白写 ——
  // 而「白写」的表现是「只有一条任务进来了」，查起来非常费劲
  const a = await pendingProposal({
    tool: 'create_task', at: { title: '第一条', date: day(11), calId: CAL }, q: '记两条',
  });
  const b = await pendingProposal({
    tool: 'create_task', at: { title: '第二条', date: day(11), calId: CAL }, q: '再记一条',
  });

  const r = confirmLib.confirm(USER, [a.proposal.id, b.proposal.id]);
  assert.deepStrictEqual(r.body.failed, [], JSON.stringify(r.body.failed));
  const tasks = sync.snapshot(USER).tasks;
  assert.ok(tasks[a.proposal.entityId], '第一条没落库');
  assert.ok(tasks[b.proposal.entityId], '第二条没落库 —— 时间戳撞了，被 LWW 判掉了');
});
