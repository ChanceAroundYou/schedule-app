/**
 * meta.test.ts —— 登录之后第一件事：先问「我是谁」，再同步
 *
 * 两个决定都有理由（`meta.ts` 的头注释）：
 *   **先 `/api/me` 再同步** —— 登录页缓存的用户对象可能是旧版本写的，而
 *     「一个集都没有」时界面是空白的；那一步不能等同步跑完。
 *   **旧数据导入放在同步之后** —— 先看服务器账号里有没有东西。否则在第二台
 *     浏览器上登录，会把本机残留的演示数据倒进一个已经有内容的账号里。
 *
 * 还有一条不写在注释里但一样重要：401 必须**抛出去**（上层要退回登录页），
 * 而「连不上服务器」不能抛（本地缓存还能用，同步那条路会再报一次）。
 *
 *   cd app && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFetch, freshStore, idleSync, signIn, CAL, ME } from './testenv.ts';

const store = await import('../data/store.ts');
const { refreshMeta, bootstrap } = await import('./meta.ts');
const { ApiError, getCachedUser } = await import('../data/api.ts');
const { LEGACY_KEY } = await import('../data/legacy.ts');

const CAL2 = 'cal-2';
const cals = [
  { id: CAL, name: '我的日程', ownerId: ME, createdAt: 0, role: 'owner' as const },
  { id: CAL2, name: '家里', ownerId: 'u2', createdAt: 0, role: 'editor' as const },
];
const mePayload = {
  user: { id: ME, name: '星星', nickname: '星星包' },
  cals,
  invites: [{ id: 'inv-1', calId: 'cal-3', inviterId: 'u2', inviteeName: '星星', role: 'viewer', createdAt: 0 }],
  users: { u2: { name: 'nian', nickname: '念念' } },
};

/** 旧版存在 `schedule-app-v1` 的那份数据（v3 形状） */
function seedLegacy(): void {
  localStorage.setItem(LEGACY_KEY, JSON.stringify({
    version: 3,
    tasks: [{ id: 'old-1', title: '旧版留下的任务', date: '2026-10-01' }],
    habits: [],
    notes: '旧版的备忘录（新版已经不要了，迁移时直接丢）',
  }));
}

test('refreshMeta 把「我是谁 / 我有哪些集 / 谁邀请了我 / 谁叫什么」全灌进本地', async () => {
  freshStore();
  const f = fakeFetch(() => mePayload);
  try { await refreshMeta(); } finally { f.restore(); }
  assert.equal(store.get().meId, ME, '认不出「这条是我建的」，来源 tag 就分不清你我');
  assert.equal(store.get().cals.length, 2);
  assert.equal(store.get().invites.length, 1);
  assert.equal(store.get().users.u2?.nickname, '念念');
  assert.equal(getCachedUser()?.nickname, '星星包', '缓存一份：服务器够不着时也要有名字可显示');
});

test('刚点完「接受邀请」就该看见新集：refreshMeta 不等同步跑完', async () => {
  freshStore();
  const f = fakeFetch(() => mePayload);
  try { await refreshMeta(); } finally { f.restore(); }
  assert.ok(store.get().cals.some((c: { id: string }) => c.id === CAL2),
    '同步那条路要等下一次同步才走，中间那段空白用户是看得见的');
});

test('bootstrap 的顺序：先 /api/me，再 /api/sync', async () => {
  freshStore();
  signIn();
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url) ? mePayload : idleSync(1)));
  try { await bootstrap(); } finally { f.restore(); }
  assert.equal(f.calls.length, 2, '只有两趟：一次问身份、一次同步（账号里有东西就别再动）');
  assert.match(f.calls[0].url, /\/api\/me$/, '第一趟必须是「我是谁」：一个集都没有时界面是空白的');
  assert.match(f.calls[1].url, /\/api\/sync$/);
});

test('/api/me 返回 401 要抛出去（上层得退回登录页，不能装作登录着）', async () => {
  freshStore();
  signIn();
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url) ? { __status: 401, error: 'Unauthorized' } : idleSync(1)));
  try {
    await assert.rejects(() => bootstrap(), ApiError, '401 必须冒到调用方');
    assert.equal(store.get().outbox.length, 0);
  } finally { f.restore(); }
});

test('/api/me 连不上时不抛：本地缓存还能用，同步那条路会再报一次', async () => {
  freshStore();
  signIn();
  /* 真断网时两趟都够不着（不是只有 /api/me 那一只请求出问题） */
  const f = fakeFetch(() => ({ __throw: 'Failed to fetch' }));
  try {
    await bootstrap();
    assert.equal(f.calls.length, 2, '照样走完同步那一趟 —— 缓存里的集与任务还能看');
    assert.equal(store.get().lastError, '连不上服务器', '但要说一次，别让界面静默地旧着');
  } finally { f.restore(); }
});

test('空账号 + 本机有旧版数据 → 搬上去，并且立刻推给服务器', async () => {
  freshStore();
  signIn();
  seedLegacy();
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url) ? { ...mePayload, cals: [cals[0]] } : idleSync(1)));
  try { await bootstrap(); } finally { f.restore(); }

  assert.equal(store.get().tasks['old-1']?.title, '旧版留下的任务');
  assert.equal(store.get().tasks['old-1']?.calId, CAL, '旧数据没有归属，统一落到当前选中的集');

  assert.equal(f.calls.length, 3, '搬完得再来一趟同步，否则旧数据只在这台浏览器里');
  const ops = (f.calls[2].body as { ops: { entityId: string }[] }).ops;
  assert.ok(ops.some((o) => o.entityId === 'old-1'), '这一趟要把迁移出来的那条推上去');
});

test('账号里已经有内容 → 不把本机残留的旧数据倒进去（第二台浏览器最容易翻车）', async () => {
  freshStore();
  signIn();
  seedLegacy();
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url)
    ? { ...mePayload, cals: [cals[0]] }
    : {
        cursor: 1, applied: [], rejected: [],
        changes: [{ entity: 'task', entityId: 'srv-1', calId: CAL, field: 'title', value: '服务器上本来就有的任务', ts: 5, deviceId: 'other-dev' }],
      }));
  try { await bootstrap(); } finally { f.restore(); }

  assert.equal(store.get().tasks['srv-1']?.title, '服务器上本来就有的任务');
  assert.equal(store.get().tasks['old-1'], undefined,
    '已经有内容的账号不该被本机演示数据灌进去 —— 那等于往共享集里写脏数据');
  assert.equal(f.calls.length, 2, '不搬就不需要第二趟同步');
});

test('本机没有旧数据 → 不多跑一趟同步', async () => {
  freshStore();
  signIn();
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url) ? { ...mePayload, cals: [cals[0]] } : idleSync(1)));
  try { await bootstrap(); } finally { f.restore(); }
  assert.equal(f.calls.length, 2);
});

test('旧键一个字节都不动：导入是「再写一份到服务端」，不是搬家', async () => {
  freshStore();
  signIn();
  seedLegacy();
  const before = localStorage.getItem(LEGACY_KEY);
  const f = fakeFetch((c) => (/\/api\/me$/.test(c.url) ? { ...mePayload, cals: [cals[0]] } : idleSync(1)));
  try { await bootstrap(); } finally { f.restore(); }
  assert.equal(localStorage.getItem(LEGACY_KEY), before,
    '万一新版有问题，退回旧版打开还得能看到原始数据（见 data/legacy.ts）');
});
