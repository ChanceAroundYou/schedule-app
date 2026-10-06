/**
 * project.test.ts —— 长周期项目的选择器口径
 *
 * 全部是纯函数，所以这里不需要任何 mock：state 造出来，断言结果。
 *
 * 最要紧的两条：
 *  - **进度**：手填优先，否则按关联任务算；没有任务时是 0 而不是 100
 *  - **停滞口径**：用 `_ts` / `createdAt` / `doneAt` 取最大，**不用新增字段**
 *    （新增一个 touchedAt 意味着「读一次写一次」，会把浏览变成写入）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_DAYS, hydrateProject, liveProjects, makeProject, makeTask, projectById,
  projectColumn, projectProgress, projectStaleDays, projectTouchedAt, sortProjects,
  tasksOfProject,
} from './model.ts';
import type { LocalState, Project, Task } from './types.ts';
import { normalizeUi } from './model.ts';

const DAY = 86400000;
const NOW = 1_800_000_000_000;   // 固定「现在」，否则用例会随真实时间漂

function stateWith(projects: Project[] = [], tasks: Task[] = []): LocalState {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    habits: {},
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    cals: [], invites: [], cursor: 0, outbox: [],
    ui: normalizeUi(undefined),
    lastError: null, clockBlocked: [], denied: 0, deniedCals: [],
    conflicts: [], syncing: false,
  };
}

/** 造项目：`ts` 写在某个字段的 `_ts` 上，用来控制「最后动了什么时候」 */
function proj(id: string, over: Partial<Project> = {}): Project {
  const p = makeProject(id, 'cal-1', id);
  return { ...p, createdAt: NOW - 10 * DAY, ...over };
}

function task(id: string, over: Partial<Task> = {}): Task {
  const t = makeTask({ id, title: id, calId: 'cal-1' });
  return { ...t, createdAt: NOW - 10 * DAY, ...over };
}

/* ============================== 列判定 ============================== */

test('projectColumn：done 优先于 doing，缺失 doing 就是待办', () => {
  assert.equal(projectColumn(task('a')), 'todo', '旧任务没有 doing → 待办，零迁移');
  assert.equal(projectColumn(task('b', { doing: true })), 'doing');
  assert.equal(projectColumn(task('c', { done: true })), 'done');
  // 两个都设上时以 done 为准 —— 不然「做完的任务」会跑到进行中那一列
  assert.equal(projectColumn(task('d', { done: true, doing: true })), 'done');
});

/* ============================== 进度 ============================== */

test('项目进度：没有关联任务时是 0，不是 100', () => {
  const s = stateWith([proj('p1')]);
  // 「一个任务都没拆」≠「做完了」—— 泳道头会显示 0/0 让用户看出来
  assert.equal(projectProgress(s, 'p1'), 0);
});

test('项目进度：按关联任务的完成比例自动算', () => {
  const s = stateWith(
    [proj('p1')],
    [
      task('t1', { projectId: 'p1', done: true }),
      task('t2', { projectId: 'p1' }),
      task('t3', { projectId: 'p1' }),
      task('t4', { projectId: 'p1' }),
    ],
  );
  assert.equal(projectProgress(s, 'p1'), 25);
  assert.equal(tasksOfProject(s, 'p1').length, 4);
});

test('项目进度：手填值覆盖自动算', () => {
  const s = stateWith(
    [proj('p1', { progress: 80 })],
    [task('t1', { projectId: 'p1', done: true }), task('t2', { projectId: 'p1' })],
  );
  assert.equal(projectProgress(s, 'p1'), 80, '自动算是 50，手填 80 要赢');
});

test('项目进度：墓碑任务不计入分母', () => {
  const s = stateWith(
    [proj('p1')],
    [
      task('t1', { projectId: 'p1', done: true }),
      task('t2', { projectId: 'p1', deleted: true }),
    ],
  );
  assert.equal(projectProgress(s, 'p1'), 100, '删掉的那条不该把分母撑大');
});

test('项目进度：手填值越界会被钳回 0–100', () => {
  const base = { id: 'x', calId: 'c', _ts: {}, _dev: {} };
  assert.equal(hydrateProject({ ...base, progress: 150 }).progress, 100);
  assert.equal(hydrateProject({ ...base, progress: -20 }).progress, 0);
  assert.equal(hydrateProject({ ...base, progress: NaN }).progress, null);
});

/* ============================== 停滞 ============================== */

test('项目停滞：认不出自己的字段就退回 createdAt', () => {
  const s = stateWith([proj('p1')]);
  assert.equal(projectTouchedAt(s, 'p1'), NOW - 10 * DAY);
  assert.equal(projectStaleDays(s, 'p1', NOW), 10);
});

test('项目停滞：关联任务刚完成 → 项目算刚动过', () => {
  const s = stateWith(
    [proj('p1')],
    [task('t1', { projectId: 'p1', done: true, doneAt: NOW - 1000 })],
  );
  // 项目自己 10 天没改，但任务昨天做完了 —— 面板要把它顶到前面
  assert.equal(projectStaleDays(s, 'p1', NOW), 0);
  assert.equal(projectTouchedAt(s, 'p1'), NOW - 1000);
});

test('项目停滞：项目自己的字段改动也算', () => {
  const p = proj('p1');
  p._ts = { next: NOW - 2 * DAY };
  const s = stateWith([p]);
  assert.equal(projectStaleDays(s, 'p1', NOW), 2);
});

test('项目停滞：一条时间戳都没有时给 0，别报一个吓人的大数', () => {
  const p = proj('p1', { createdAt: 0 });
  const s = stateWith([p]);
  assert.equal(projectTouchedAt(s, 'p1'), 0);
  assert.equal(projectStaleDays(s, 'p1', NOW), 0);
});

test('项目停滞：STALE_DAYS 是 30，且判据是「大于等于」', () => {
  assert.equal(STALE_DAYS, 30);
  // createdAt 也要比 30 天更早，否则取最大时它会把 _ts 压过去 ——
  // projectTouchedAt 是「取最大」，不是「只看 _ts」
  const p = proj('p1', { createdAt: NOW - 100 * DAY });
  p._ts = { next: NOW - STALE_DAYS * DAY };
  const s = stateWith([p]);
  assert.equal(projectStaleDays(s, 'p1', NOW), STALE_DAYS);
  assert.ok(projectStaleDays(s, 'p1', NOW) >= STALE_DAYS, '到了这天就该标 ⚠');
});

/* ============================== 排序 ============================== */

test('排水道：最久没动的排最前面', () => {
  const fresh = proj('p-fresh');
  fresh._ts = { next: NOW - 1 * DAY };
  const mid = proj('p-mid');
  mid._ts = { next: NOW - 5 * DAY };
  const old = proj('p-old');
  old._ts = { next: NOW - 40 * DAY };
  const s = stateWith([fresh, mid, old]);

  assert.deepEqual(sortProjects(s, liveProjects(s)).map((p) => p.id),
    ['p-old', 'p-mid', 'p-fresh']);
});

test('排水道：都没动过时按名字给一个稳定序', () => {
  const a = proj('b-项目');
  const b = proj('a-项目');
  const s = stateWith([a, b]);
  // 两条 touchedAt 都是 createdAt（一样），不能靠插入顺序 —— 那在两次渲染间会抖
  assert.deepEqual(sortProjects(s, liveProjects(s)).map((p) => p.name), ['a-项目', 'b-项目']);
});

/* ============================== 可见性 ============================== */

test('墓碑与已清除的项目不出现在列表里', () => {
  const s = stateWith([
    proj('keep'),
    proj('gone', { deleted: true }),
    proj('purged', { deleted: true, purged: true }),
  ]);
  assert.deepEqual(liveProjects(s).map((p) => p.id), ['keep']);
  assert.equal(projectById(s, 'gone'), null, '墓碑不算「还活着」');
  assert.equal(projectById(s, 'nope'), null);
  assert.equal(projectById(s, null), null, 'null 不该抛');
});

test('hydrateProject 把缺的字段补齐，认不出的 status 兜回 active', () => {
  const base = { id: 'x', calId: 'c', _ts: {}, _dev: {} };
  const p = hydrateProject({ ...base });
  assert.equal(p.name, '未命名项目');
  assert.equal(p.note, '');
  assert.equal(p.next, '');
  assert.equal(p.progress, null);
  assert.equal(p.status, 'active');
  assert.equal(hydrateProject({ ...base, status: '乱写' as never }).status, 'active');
  assert.equal(hydrateProject({ ...base, status: 'paused' }).status, 'paused');
});
