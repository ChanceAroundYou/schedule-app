/**
 * flow.test.ts —— 每日流程的领域逻辑
 *
 * 这里钉的是几条「改了就会伤用户」的规矩：
 *   · 模板生成当天清单时，完成状态必须清零（否则昨天的勾会带进明天）
 *   · 改顺序是整体移动，不是交换（连点两下「下移」应该真的往下走两格）
 *   · 坏数据逐条过滤，不能让一条坏项把整天吞掉
 *   · 标题被清空时保留原值（不留一行看不见字的流程）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeItems, normalizeDoc, fromTemplate, makeItem, moveItem,
  toggleItem, patchItem, removeItem, progressOf, currentItem, newId,
} from './flow.ts';

const item = (id: string, title = id, over: Partial<ReturnType<typeof makeItem>> = {}) => ({
  ...makeItem(title), id, ...over,
});

test('流程项归一：坏数据逐条过滤，好的一条不丢', () => {
  const raw = [
    { id: 'a', title: '  起床  ', at: '07:30' },
    { id: 'b', title: '   ' },                  // 空标题 → 丢掉
    null,
    'nonsense',
    { id: 'c', title: '看书', at: '25:99' },     // 时间非法 → 变 null，项还在
    { id: 'a', title: '重复 id' },               // 同 id 第二条 → 丢掉
  ];
  const out = normalizeItems(raw);
  assert.deepEqual(out.map((x) => x.id), ['a', 'c']);
  assert.equal(out[0].title, '起床', '标题去首尾空格');
  assert.equal(out[0].at, '07:30');
  assert.equal(out[1].at, null, '非法时间打回 null，不被画成一个怪值');
});

test('流程项归一：非数组 / 全坏数据给空清单，不抛', () => {
  assert.deepEqual(normalizeItems(null), []);
  assert.deepEqual(normalizeItems({ items: [] }), []);
  assert.deepEqual(normalizeItems([{}, { title: '' }]), []);
  assert.equal(normalizeDoc({ items: [] })?.rev, 0);
  assert.equal(normalizeDoc(null), null);
  assert.equal(normalizeDoc({ rev: 3 }), null, '没有 items 的文档不算文档');
});

test('模板 → 当天：顺序与内容照抄，完成状态清零', () => {
  const tpl = [
    { ...item('a', '洗漱'), done: true, doneAt: 111 },
    { ...item('b', '看书'), at: '20:00' },
  ];
  const day = fromTemplate(tpl);
  assert.deepEqual(day.map((x) => x.id), ['a', 'b'], '顺序与 id 保留');
  assert.deepEqual(day.map((x) => x.title), ['洗漱', '看书']);
  assert.equal(day[0].done, false, '模板里的勾不能带进当天');
  assert.equal(day[0].doneAt, null);
  assert.equal(day[1].at, '20:00', '参考时间照抄');
});

test('上移 / 下移：整体移动，越界不动（原数组引用不变）', () => {
  const list = [item('a'), item('b'), item('c')];
  assert.deepEqual(moveItem(list, 'c', 0).map((x) => x.id), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(list, 'a', 1).map((x) => x.id), ['b', 'a', 'c']);
  assert.equal(moveItem(list, 'a', 0), list, '没动就返回原引用，调用方据此跳过写入');
  assert.equal(moveItem(list, 'a', -5), list, '越界同样不动');
  assert.equal(moveItem(list, 'ghost', 0), list);
});

test('打勾：只改那一条，完成时刻只在勾上时记', () => {
  const list = [item('a'), item('b')];
  const on = toggleItem(list, 'a', 1234);
  assert.equal(on[0].done, true);
  assert.equal(on[0].doneAt, 1234);
  assert.equal(on[1].done, false, '别的项不受影响');
  const off = toggleItem(on, 'a', 5678);
  assert.equal(off[0].done, false);
  assert.equal(off[0].doneAt, null, '取消勾选要清掉完成时刻');
});

test('改名：清空标题保留原值，不合法时间打回 null', () => {
  const list = [item('a', '原样')];
  assert.equal(patchItem(list, 'a', { title: '   ' })[0].title, '原样');
  assert.equal(patchItem(list, 'a', { title: ' 新名字 ' })[0].title, '新名字');
  assert.equal(patchItem(list, 'a', { at: '9:00' })[0].at, null, '只认两位数小时');
  assert.equal(patchItem(list, 'a', { at: '09:00' })[0].at, '09:00');
  assert.equal(patchItem(list, 'a', { at: null })[0].at, null, '可以清空时间');
});

test('删除 / 进度 / 下一项', () => {
  const list = [item('a'), item('b'), item('c')];
  assert.deepEqual(removeItem(list, 'b').map((x) => x.id), ['a', 'c']);

  assert.deepEqual(progressOf([]), { done: 0, total: 0 });
  assert.deepEqual(progressOf(list), { done: 0, total: 3 });
  assert.equal(currentItem(list)?.id, 'a', '下一项 = 第一条没完成的');
  const done = list.map((x) => ({ ...x, done: true }));
  assert.equal(currentItem(done), null, '全做完就没有下一项');
});

test('新 id 不重复', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId()));
  assert.equal(ids.size, 500);
});
