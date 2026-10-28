/**
 * people.test.ts —— 昵称回退、首字、集颜色、来源标记的判据
 *
 * 全是纯函数（`domain/` 不许碰 React / 网络），所以 state 直接造、断言结果。
 *
 * 最要紧的三条：
 *  - **回退**：昵称空 / 全空格 / 缺字段都退回用户名，两条路径不能给出不同的名字
 *  - **「非自己添加」判据只此一处**：自己建的、AI 建的、不认识的人建的，各是什么结果
 *  - **集颜色有默认值**：集上没 color（老数据 / 老服务器）时不能画成「没颜色」
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_ACTOR, colorOf, creatorOf, displayName, initialOf } from './people.ts';
import { CAL_COLORS, DEFAULT_CAL_COLOR } from './types.ts';
import type { Cal, CalColorKey } from './types.ts';

const cal = (id: string, color?: CalColorKey): Cal =>
  ({ id, name: '集' + id, ownerId: 'u1', createdAt: 0, role: 'owner', ...(color ? { color } : {}) });

/* ============================== 显示名 ============================== */

test('优先昵称；没有昵称退回用户名', () => {
  assert.equal(displayName({ name: 'alex', nickname: '小星' }), '小星');
  assert.equal(displayName({ name: 'alex', nickname: null }), 'alex');
  assert.equal(displayName({ name: 'alex' }), 'alex');
});

test('只有空格的昵称等于没有昵称（不能画出一个空名字）', () => {
  assert.equal(displayName({ name: 'alex', nickname: '   ' }), 'alex');
  assert.equal(displayName({ name: '星', nickname: '' }), '星');
});

test('什么都不给时不抛、不返回 undefined', () => {
  assert.equal(displayName(undefined), '');
  assert.equal(displayName({ name: '', nickname: '' }), '');
});

/* ============================== 首字 ============================== */

test('首字取昵称的第一个字， latin 大写', () => {
  assert.equal(initialOf({ name: 'alex', nickname: '小星' }), '小');
  assert.equal(initialOf({ name: 'alex', nickname: 'lu' }), 'L');
  assert.equal(initialOf({ name: '王小明', nickname: null }), '王');
});

test('代理对（emoji 昵称）取整枚，不砍半个码点', () => {
  assert.equal(initialOf({ name: 'x', nickname: '🙂星' }), '🙂');
});

test('空名字给「?」而不是空圆圈', () => {
  assert.equal(initialOf(undefined), '?');
  assert.equal(initialOf({ name: '', nickname: null }), '?');
});

/* ============================== 集颜色 ============================== */

test('集颜色按 calId 取；找不到集 / 集上没颜色都退回默认色', () => {
  const cals = [cal('a', 'plum'), cal('b')];
  assert.equal(colorOf(cals, 'a'), 'plum');
  assert.equal(colorOf(cals, 'b'), DEFAULT_CAL_COLOR);
  assert.equal(colorOf(cals, '不存在的集'), DEFAULT_CAL_COLOR);
  assert.equal(colorOf([], 'a'), DEFAULT_CAL_COLOR);
});

test('默认色本身在候选表里（不然色板画不出「当前」那一格）', () => {
  assert.ok(CAL_COLORS.includes(DEFAULT_CAL_COLOR));
});

/* ============================== 来源标记 ============================== */

const USERS = {
  u1: { name: 'alex', nickname: '小星' },
  u2: { name: 'bao', nickname: '阿包' },
};

test('自己建的不画（meId 命中 createdBy）', () => {
  assert.equal(creatorOf(USERS, 'u1', 'u1'), null);
});

test('AI 建的不画（它不是「别人」）', () => {
  assert.equal(creatorOf(USERS, AI_ACTOR, 'u1'), null);
});

test('没记 createdBy 的老任务不画（判不出是谁建的，就不猜）', () => {
  assert.equal(creatorOf(USERS, null, 'u1'), null);
  assert.equal(creatorOf({}, undefined, 'u1'), null);
});

test('离线 / 未登录（meId 为 null）一律不画 —— 不然自己的任务全被标成别人的', () => {
  assert.equal(creatorOf(USERS, 'u1', null), null);
});

test('别人建的画首字，标题用昵称', () => {
  assert.deepEqual(creatorOf(USERS, 'u2', 'u1'), { initial: '阿', title: '阿包' });
});

test('目录里没有这个人（刚被移出他的集）不空转，给可读说明', () => {
  const c = creatorOf(USERS, 'u9', 'u1');
  assert.ok(c);
  assert.equal(c!.title, '不认识的成员');
  assert.equal(c!.initial, '?');
});

test('目录里没这个人、但他名字本身能算出首字时优先用目录（目录有就用）', () => {
  assert.deepEqual(creatorOf({ u3: { name: 'chen', nickname: null } }, 'u3', 'u1'),
    { initial: 'C', title: 'chen' });
});
