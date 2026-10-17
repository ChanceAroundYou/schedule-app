/**
 * tasks.ts —— 任务的写入通道（新建 / 勾选 / 改 / 删 / 垃圾箱）
 *
 * **全部走 `commit()` / `commitMany()`**，所以权限把关（`canWrite`）、被挡提示
 * （`deny()`）、发件箱、冲突记录自动全都有 —— 这里一个都不重复。
 */
import type { Task } from '../../domain/types.ts';
import {
  makeTask, nextOrder, trashedTasks, trashedHabits,
} from '../../domain/model.ts';
import { seriesRootOf, instanceId, repeatNext, repeatAdvance, toRepeat, parseInstanceId } from '../../domain/repeat.ts';
import type { RepeatRule } from '../../domain/types.ts';
import * as D from '../../domain/date.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany, type Change } from './commit.ts';

export interface TaskDraft {
  title: string;
  note?: string;
  date?: string | null;
  time?: string | null;
  duration?: number | null;
  repeat?: unknown;
  source?: string | null;
}

export function addTask(d: TaskDraft): string {
  const date = d.date ?? null;
  const t = makeTask({
    calId: state.ui.cal || '',
    title: d.title,
    note: d.note || '',
    date,
    time: d.time ?? null,
    duration: d.duration ?? null,
    repeat: toRepeat(d.repeat, date),
    seriesId: null,
    order: d.time ? null : nextOrder(state, date),
    createdAt: Date.now(),
    source: d.source ?? null,
  });
  // 非重复任务没有系列根；重复任务以自己为根（后续实例的 id 从这里派生）
  if (t.repeat.unit !== 'none') t.seriesId = t.id;

  commitMany([{ entity: 'task', id: t.id, fields: dataOf(t) }]);
  // 新建的重复任务：顺手把未来几次也生成出来（用户 2026-10-14 要求）
  if (t.repeat.unit !== 'none') ensureRepeatOccurrences();
  return t.id;
}

/**
 * 重复实例**预先铺到多远的将来**（天）。
 *
 * ⚠️ 2026-10-17 从「14 次」改成「120 天」（用户报「2027-01-23 之后彻底消失」）：
 * 按**次数**算窗口有个致命毛病 —— 一周一次时 14 次 = 14 周（约 3 个半月），
 * 一周三次时 14 次只 = 4 周半；更要命的是**改规则会让现有条数超过窗口**，
 * 于是「够不够」永远判成够，窗口再也不往前推。用户实测就是卡在 2027-01-22。
 *
 * 现在按**时间**铺：不管一周几次，一律铺到「今天 + 120 天」。
 * 用户翻到更远的月份时，调用方再通过 `until` 把目标日期推过去（见 Workbench）。
 */
export const REPEAT_HORIZON_DAYS = 120;

/**
 * 单次补齐的上限条数。
 *
 * 防病态输入：每天重复 + 用户翻到三年后 = 上千条，一次全建出来会把同步撑爆。
 * 正常使用（120 天 + 最多一天一次）远到不了这个数。
 */
export const REPEAT_FILL_CAP = 500;

/**
 * 给所有「重复且未完成」的任务补齐未来 N 次实例（真的写进库）。
 *
 * 背景：App 原本是**完成即派生**（勾掉这一次才产生下一次），所以在「下周三」
 * 看不到这条任务。用户 2026-10-14 选择「预生成若干次」，于是这里按**确定性
 * 实例 id**（`seriesId#日期`）把后续几次建出来 —— id 确定性保证多设备 / 反复
 * 调用都能收敛（已存在就跳过）。
 *
 * 幂等：每次都先查 id 在不在。可以挂在同步之后反复调，不会重复建。
 * 只补**今天及以后**的发生日，不去把过去的历史补出来（那只会污染列表）。
 *
 * ⚠️ 2026-10-17 大改（用户报「每周五六只显示周六」「全部删除只删当天」），
 * 这一遍现在同时干三件事，按顺序：
 *   ① **按当前规则走一遍「锚点 → 最远实例」**，得到这本应存在的发生日序列；
 *   ② **回填中间的洞**（create-only）：窗口被旧规则铺满之后再改规则，
 *      `need = 窗口目标 − 现有数` 会是 0，什么都不补 —— 周五那种「改了
 *      规则却永远不出现」的日子只有按洞补才救得回来；
 *   ③ **清理规则缩水的残留**：把今天及以后、未完成、不再符合当前规则的
 *      实例删掉（每周五六改成每周五，周六的残留不能继续挂在未来）。
 * 三件事都只**新建/删除这一遍该动的东西**，不重铺整个窗口 —— 重铺会毁掉
 * 用户对未来实例的编辑和拖拽。
 *
 * @param opts.until 额外要铺到的日期（yyyy-MM-dd）。用户翻到更远的月份时，
 *   调用方把「那天 + 缓冲」传进来，按需把窗口推过去 —— 这样既能随时看到
 *   很远的日子，又不用一上来就生成几千条。
 */
export function ensureRepeatOccurrences(opts?: { until?: string | null; revive?: boolean }): void {
  // 先把「已结束的系列」清理干净（幂等，无变动时不动）
  enforceRepeatUntil();

  const items: Change[] = [];
  const now = Date.now();
  const today = D.today();

  /* 改规则时**复活**被「系列结束」清掉的未来空位（2026-10-17 晚）。
   *
   * 用户实测：先把「每月 19 日」的系列「从此往后全部删除」（那批未来的日子
   * 都留下墓碑），再把规则改成「每周一」。墓碑的 id 是
   * `系列根#日期`，补齐时看到「这个 id 已经存在」就直接跳过 —— 于是新规则
   * 里那些空位永远造不出来，用户看到的就是「设了每周一，之后一个都没有」。
   *
   * 只复活两种条件都满足的：**今天及以后** + **不是 `skipped`**。
   * `skipped` 是「只删这一次」打的标记 —— 那是用户对某一天的明确决定，
   * 换个规则也不该翻案。 */
  const revive = opts?.revive === true;
  const reviveDead = (id: string, date: string): boolean => {
    const dead = state.tasks[id];
    if (!dead) return false;
    if (!dead.deleted) return true;          // 已经活着，什么都不用做
    if (!revive) return false;
    if (dead.skipped) return false;          // 「只删这一次」不复活
    if (typeof date !== 'string' || date < today) return false;
    /* 内存里用 undefined（Task 的类型是可选字段），写入通道里用 null ——
       同步协议里 null 才是「把这个字段清空」，undefined 只是本地省掉。 */
    const restored: Task = { ...dead, deleted: false, deletedAt: undefined, trashFrom: undefined, skipped: false };
    state.tasks[id] = restored;
    items.push({
      entity: 'task', id, calId: dead.calId,
      fields: { deleted: false, deletedAt: null, trashFrom: null, skipped: false },
    });
    return true;
  };

  /* 铺到哪天：默认「今天 + 120 天」；调用方要更远（翻到了后面月份）就取更远的那个 */
  const defUntil = D.addDays(today, REPEAT_HORIZON_DAYS);
  const until = (opts && typeof opts.until === 'string' && opts.until > defUntil)
    ? opts.until : defUntil;

  /* 系列级「到此为止」标记：家族根 → 结束日。
   *
   * 标记**不一定写在根上**：根被「只删这一次」删掉后墓碑还在、字段还在；
   * 但根要是不在本机（别的设备建的系列），deleteSeriesFrom 会把标记写在
   * 家族里还能活过那次删除的成员身上。所以这里全量扫一遍、按家族归并 ——
   * 比「只认 state.tasks[seriesId].repeatUntil」稳（旧写法漏认标记时，
   * 删完的系列又会长回来，正是「删了等于没删」的另一半原因）。 */
  const markers = new Map<string, string>();
  for (const t of Object.values(state.tasks)) {
    if (!t) continue;
    const u = (typeof t.repeatUntil === 'string' && t.repeatUntil) ? t.repeatUntil : null;
    if (u === null) continue;
    const root = seriesRootOf(t) ?? t.id;
    const prev = markers.get(root);
    if (prev === undefined || u < prev) markers.set(root, u);
  }

  /* 按**系列**归组，每个系列只处理一次（2026-10-14 重构）。
   *
   * 之前是「遍历所有任务、只挑出系列根（seriesId === id）」，有两个毛病：
   *   ① 根一旦被删 —— 用户对根那一次选了「只删这一次」—— 整个系列就死了，
   *      于是「只删这一次」实际效果等于「删掉整个系列」；
   *   ② 判据说的是「谁是根」，而不是「这个系列还活着吗」。而根被勾成已完成时
   *      也会被跳过，于是**完成第一次发生之后窗口就再也不补**，
   *      攒下的那些实例用完就断（用户报的另一半症状）。
   *
   * 现在按 seriesRootOf 归组：只要组里还有一条活着的任务，系列就继续派生。
   * 规则从「还活着的那条」上读 —— 实例身上带着同一份 repeat 的完整副本，
   * 所以根没了也能继续。
   * 2026-10-17 起 seriesRootOf 改成**形状优先**（id 带 # 就以 # 前的为真根），
   * 所以被小组件改Instance repeat 改乱了血脉（seriesId 指向中间层 / 整个缺失）
   * 的旧数据也会归到同一条家族下 —— 删除和补齐都不会再漏掉旁支。 */
  const groups = new Map<string, typeof state.tasks[string][]>();
  for (const o of Object.values(state.tasks)) {
    if (!o || o.deleted) continue;
    const root = seriesRootOf(o);
    if (!root) continue;
    let g = groups.get(root);
    if (!g) { g = []; groups.set(root, g); }
    g.push(o);
  }

  for (const [root, members] of groups) {
    // 定义来源：优先系列根本身（它的标题/时间是「原始定义」），
    // 根被删就退而取组里任何一条。
    const rootTask = state.tasks[root];
    const t = (rootTask && !rootTask.deleted) ? rootTask : members[0];
    const r = t.repeat;
    if (!r || r.unit === 'none') continue;
    /* 已被「从某天起全部删除」结束的系列：标记只作**上界**，不是整组跳过
     * （2026-10-17 晚改，用户实测）。
     *
     * 用户先把「每月 19 日」的系列删成「到此为止」（写下 repeatUntil），
     * 之后又把规则改成「每周一」—— 旧写法 `if (markers.has(root)) continue`
     * 让整组一条都不补，用户看到的就是「设了每周一，之后所有周一都不出现」。
     * 标记的语义本来就只是「这天及以后不要」，它之前的日子照常该有。
     * 真正让「删了不再长回来」成立的是 `enforceRepeatUntil()`（把结束日及以后
     * 的实例删掉）+ 这里的上界，两道合起来足够，不需要整组跳过。
     * 「用户改规则后应当整体失效」由 patchTask 里的 clearSeriesEnd 负责。 */
    const end = markers.get(root) ?? null;

    /* 家族已存在的发生日（含已完成、不含已删）。
     * ⚠️ 只收**严格的 yyyy-MM-dd**：脏日期（同步写坏的非字符串、残缺串）
     * 进不了锚点/游标，否则 Date.parse 出 NaN → 走序一步都不走 →
     * `expected` 空 → 下面的「缩水清理」会把整个家族未来的实例全删了。
     * 宁可漏补，不可误删。 */
    const dates = members
      .map((o) => o.date)
      .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (!dates.length) continue;      // 一条带日期的都没有，没什么可对齐的
    const anchor = dates[0];               // 最早的发生日 = 系列的起点
    const furthest = dates[dates.length - 1];   // 最远已存在的实例
    let maxSeq = 0;
    for (const o of members) {
      if ((o.repeatSeq ?? 0) > maxSeq) maxSeq = o.repeatSeq ?? 0;
    }

    /* ① 按**当前规则**从锚点走到最远实例，得到「这本应存在的发生日」序列。
     *
     * 步数上限定锚点到最远实例的天数：规则再密也密不过「每天」，
     * 所以 `spanDays + 16` 一定够；不够只会让序列截断（见下面的用途），
     * 不会死循环。 */
    const plan: { date: string; seq: number }[] = [];
    {
      const spanDays = Math.max(1, (Date.parse(furthest) - Date.parse(anchor)) / 86400000);
      let cur = anchor;
      let seq = 0;
      for (let guard = 0; guard <= spanDays + 16; guard++) {
        plan.push({ date: cur, seq });
        const nxt = nextOccurrence(r, cur, seq);
        if (!nxt || nxt <= cur) break;   // 规则到头 / 原地踏步
        cur = nxt;
        seq += 1;
        if (cur > furthest) break;
      }
    }
    const expected = new Set(plan.map((p) => p.date));
    /* 已占用的发生日。**不能只查 `state.tasks[instanceId(root, date)]`**：
     * 系列根本身的 id 是随机 uuid（不是派生形状），它占着锚点那天，
     * 按派生 id 查不到 → 补洞会在同一天再造出一条和根一模一样的任务。
     * 所以拿家族成员的日期一并作为「已占用」。 */
    const taken = new Set(dates);

    /* ③ 规则缩水清理：把「今天及以后、未完成、不再符合当前规则」的实例删掉
     *    （用户 2026-10-17：每周五六改成每周五之后，周六的残留还挂在未来）。
     *    三道保护一个都不能少：
     *      · 系列根本身（护根）；
     *      · 已完成的 —— 那是用户真的做完过的，不是规则残留；
     *      · 被手动拖拽过的 —— 派生 id 里编码的是**原发生日**，`date` 和它
     *        不一致就说明用户把这一次挪去过（拖拽 / 改日期），不是残留。
     *        没有这道保护，用户拖一次任务，下一轮同步就把它当残留删了。
     *      · 锚点（plan 的第一项）天然在 expected 里，同样受保护。 */
    const doomed = new Set<string>();
    for (const o of members) {
      // 只清**今天及以后、日期干净**的；脏日期动不了（清它可能误伤，留着由用户处理）
      if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) continue;
      if (o.date < today) continue;
      if (o.done) continue;
      if (o.id === root) continue;
      const orig = parseInstanceId(o.id);
      if (orig && orig.date !== o.date) continue; // 手动挪过日期
      if (expected.has(o.date)) continue;
      doomed.add(o.id);
      items.push({
        entity: 'task', id: o.id, calId: o.calId,
        fields: { deleted: true, deletedAt: now, trashFrom: '重复规则变更' },
      });
    }
    // 被清掉的不再占窗口，下面按**清理后**的存活成员重算
    const live = members.filter((o) => !doomed.has(o.id));

    /* ② create-only 补洞：锚点 → 最远实例之间，按当前规则补上**缺失**的日子。
     *
     *    这就是「每周五六只显示周六」的修法：窗口早在规则还是 [周六] 的
     *    时候就铺满了 14 条周六，改成 [周五、周六] 之后 `need` 一直是 0，
     *    而按缺口补只会从最远实例**往后**推，中间的周五永远回不来。
     *    现在按洞补：走一遍规则序列，缺一个建一个，已存在的（含墓碑和
     *    「只删这一次」的跳过标记）一律不碰。
     *
     *    范围收到「今天 → 最多一年后」：超过一年的洞等窗口滚过去自然补，
     *    不至于因为某条实例被拖到很远而使一次补出上千条。 */
    const gapLimit = D.addDays(today, 366);
    for (const p of plan) {
      if (taken.has(p.date)) continue;               // 这天已经有任务占着了（根也算）
      if (p.date < today || p.date > gapLimit) continue;
      const id = instanceId(root, p.date);
      // 已存在且活着 / 刚被复活 → 都不用重建；剩下的是「不复活」的墓碑
      if (reviveDead(id, p.date)) continue;
      if (state.tasks[id]) continue;                  // 墓碑（含「只删这一次」）→ 不碰
      const occ = makeTask({
        id, calId: t.calId, title: t.title, note: t.note,
        date: p.date, time: t.time, duration: t.duration,
        repeat: r, repeatSeq: p.seq, seriesId: root,
        order: null, ord: null, createdAt: now, source: t.source ?? null,
      });
      occ.reminder = t.reminder ?? null;
      state.tasks[id] = occ;
      items.push({ entity: 'task', id, calId: t.calId, fields: dataOf(occ) });
    }

    /* ⚠️ 2026-10-17：窗口从「补够 14 次」改成「铺到某个日期」。
     *
     * 旧写法的问题是**按次数算**：一周一天时 14 次 = 14 周，一周三天时
     * 14 次只够 4 周半；更糟的是改规则会让现有条数超过窗口，`need` 直接
     * 变负 → 窗口再也不往前推（用户实测卡在 2027-01-22）。
     * 现在从最远实例往后一路铺到 `until`（默认今天 + 120 天），到点就停 ——
     * 既不会无限膨胀，也不会因为「现有条数」提前收工。 */
    const liveDates = live
      .map((o) => o.date)
      .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    /* 游标取**全部**实例（含已完成）里最远的那天。
     *
     * 试过用「未完成的最远」，结果补不齐：完成掉的那些 id 仍占在
     * `state.tasks` 里，游标又退回到它们之前，推出来的 id 全都撞上已存在
     * 的实例被跳过 —— 实测「完成 1 条 → 只补出 0 条」，缺口永远填不上。
     * 用最远的（含已完成）才能保证每次都往**全新的**日期上走。 */
    let cursor = liveDates.length ? liveDates[liveDates.length - 1] : (t.date || today);
    /* seq 取**已存在的最大 repeatSeq**，不是实例个数（2026-10-14 修）。
     *
     * 用 `existing.length` 看着等价，其实不对：预生成已经把未来几次铺满了，
     * 于是库里躺着 N 条、seq 也就是 N，「按N 次结束」会被预生成的这些占满 ——
     * 用户勾选一次想再要下下一次时，发现次数已经用完，派生不出来
     * （实测 end.count=1 的系列，勾选后 seq 从 0 跳到 2）。
     * repeatSeq 表达的是「这是第几次发生」，语义上才是对的。 */
    let seq = maxSeq;
    // ⚠️ 游标先**推进一步**再生成（2026-10-14 修）。
    // 原来的写法是「拿最后一个已有日期直接生成」，于是第一天就会造出一个
    // 与系列根**同日期**的实例（根是 10-14，实例也是 10-14）—— 同一天出现
    // 两条一模一样的任务。正确语义：根就是「第一次发生」，实例从第二次开始。
    // 推不到下一步（规则已结束）就没什么可补的。
    let advanced = nextOccurrence(r, cursor, seq);
    if (!advanced) continue;
    cursor = advanced;
    seq += 1;

    // 游标可能还停在今天之前（窗口内但今天的实例尚未生成），先推到今天或之后
    if (cursor < today) {
      let reached = false;
      for (let guard = 0; guard < 800; guard++) {
        const nxt = nextOccurrence(r, cursor, seq);
        if (!nxt) break;
        cursor = nxt;
        seq += 1;
        if (nxt >= today) { reached = true; break; }
      }
      if (!reached) continue;
    }

    // 从游标一路铺到 until；已经铺到位（cursor > until）时这个循环一次都不跑。
    // 有「到此为止」标记时还要卡在 end 之前（不含）—— `>= end` 的日子不再派生。
    for (let i = 0; i < REPEAT_FILL_CAP && cursor <= until && (end === null || cursor < end); i++) {
      const id = instanceId(root, cursor);
      if (!reviveDead(id, cursor) && !state.tasks[id]) {
        const occ = makeTask({
          id, calId: t.calId, title: t.title, note: t.note,
          date: cursor, time: t.time, duration: t.duration,
          repeat: r, repeatSeq: seq, seriesId: root,
          order: null, ord: null, createdAt: now, source: t.source ?? null,
        });
        occ.reminder = t.reminder ?? null;
        state.tasks[id] = occ;
        items.push({ entity: 'task', id, calId: t.calId, fields: dataOf(occ) });
      }
      const nxt = nextOccurrence(r, cursor, seq);
      if (!nxt) break;
      cursor = nxt;
      seq += 1;
    }
  }
  if (items.length) commitMany(items);
}

/**
 * 让 `repeatUntil` 这个标记**自愈**：把已结束系列里、落在结束日及以后的实例删掉。
 *
 * 为什么需要它（2026-10-14）：用户可以在**任何一端**（App / 小组件）选
 * 「从这次起往后全部」。那一端只能看到自己手里的那些实例 —— 小组件看得见
 * 今天 ±45 天、App 看得见全部，但都不一定知道别的设备建过什么。
 * 与其让发起端去枚举「要删哪些」，不如只落一个**标记**（根任务上的
 * repeatUntil），然后每一端在自己这里按标记清理。这样：
 *   · 发起端漏删的，另一端一同步就补上；
 *   · 新设备首次同步也会自动收敛到同一状态。
 *
 * 幂等：没有 repeatUntil 的系列直接跳过；已经删过的实例不再重复写。
 *
 * ⚠️ 2026-10-17：标记**按家族真根归并**，不再假设它一定写在系列根本身。
 * 实际数据里标记可能落在：被「只删这一次」删掉的根墓碑上、别的设备建的
 * 系列里本机没有的根（deleteSeriesFrom 会把标记改写到存活成员身上）、
 * 以及被小组件改乱了血脉的旁支任务上。旧写法按 `id === 标记所在任务`
 * 收集，漏掉旁支 → 删不干净、过两天又长回来。
 */
export function enforceRepeatUntil(): void {
  const items: Change[] = [];
  const now = Date.now();

  // 标记 → 家族根（形状优先的真根），同一家族取最早的结束日
  const markers = new Map<string, string>();
  for (const t of Object.values(state.tasks)) {
    if (!t) continue;   // 根自己很可能就是墓碑，不能跳过
    const u = (typeof t.repeatUntil === 'string' && t.repeatUntil) ? t.repeatUntil : null;
    if (u === null) continue;
    const root = seriesRootOf(t) ?? t.id;
    const prev = markers.get(root);
    if (prev === undefined || u < prev) markers.set(root, u);
  }
  if (!markers.size) return;

  for (const o of Object.values(state.tasks)) {
    if (!o || o.deleted) continue;
    const root = seriesRootOf(o);
    if (!root) continue;
    const until = markers.get(root);
    if (until === undefined) continue;
    if (!o.date || o.date < until) continue;
    items.push({
      entity: 'task', id: o.id, calId: o.calId,
      fields: { deleted: true, deletedAt: now, trashFrom: '重复任务结束' },
    });
  }
  if (items.length) commitMany(items);
}

/** base 之后的下一次发生日（含结束条件判断）。seq = 已推进的次数 */
function nextOccurrence(rule: RepeatRule, base: string, seq: number): string | null {  const next = repeatAdvance(rule, base);
  if (!next) return null;
  const end = rule.end;
  if (end) {
    if (end.type === 'date' && end.date && next > end.date) return null;
    if (end.type === 'count' && seq + 1 > (end.count || 0)) return null;
  }
  return next;
}

/**
 * 勾选 / 取消勾选。
 *
 * 勾上一条**重复**任务时会顺手派生下一个实例。这一步是本次重构的核心：
 * 新旧实现都是「完成即派生」，区别在实例 id 的来源。旧版 `randomUUID()`
 * 让两台设备各自离线勾选时派生出两个不同的实例，同步后任务翻倍；
 * 现在 id 是 `${seriesId}#${发生日}`，两边算出来一模一样，自然合并成一条。
 */
export function toggleTask(id: string): void {
  const t = state.tasks[id];
  if (!t || t.deleted) return;

  const done = !t.done;
  const now = Date.now();
  commit('task', id, { done, doneAt: done ? now : null });
  if (!done) return;

  const root = seriesRootOf(t);
  if (!root) return;

  const nextDate = repeatNext(t, t.date || D.today());
  if (!nextDate) return;

  const nextId = instanceId(root, nextDate);
  const existing = state.tasks[nextId];
  if (existing) {
    // 另一台设备已经建过这一次的实例了 —— 派生 id 相同，本来就是同一条。
    // **不重写字段**：本机这份标题/时间可能已经过期，重写会用旧值盖掉对方的编辑。
    // 只在它被误删的情况下救回来。
    if (existing.deleted === true) {
      commit('task', nextId, { deleted: false, deletedAt: null, purged: false });
    }
    return;
  }

  commit('task', nextId, {
    title: t.title, note: t.note,
    date: nextDate, time: t.time, duration: t.duration,
    done: false, doneAt: null,
    repeat: t.repeat, repeatSeq: (t.repeatSeq || 0) + 1,
    seriesId: root, order: null, ord: null,
    createdAt: now, source: t.source ?? null,
  });
}

/**
 * 两条重复规则是否等价 —— 用来判断「用户是不是真的改了规则」。
 *
 * 只比**规则本身**，不比派生出来的东西：weekdays 顺序无关（[5,6] 与 [6,5]
 * 是同一条规则），end 归一成 `n` / `d日期` / `c次数` 再比。
 * 不做这个归一的话，弹层里点一下同样的选项也会被当成「改了规则」，
 * 于是每次点开重复设置都可能把用户的「到此为止」清掉。
 */
function sameRepeat(a: RepeatRule | null | undefined, b: RepeatRule | null | undefined): boolean {
  const norm = (r: RepeatRule | null | undefined): string => {
    if (!r || r.unit === 'none') return 'none';
    const days = [...(r.weekdays ?? [])].sort((x, y) => x - y).join(',');
    const end = !r.end ? 'never'
      : r.end.type === 'date' ? 'd:' + r.end.date
      : 'c:' + r.end.count;
    return [r.unit, r.n, days, r.monthday, r.yearMonth ?? '', end].join('|');
  };
  return norm(a) === norm(b);
}

/**
 * 撤销某个系列的「到此为止」标记。
 *
 * 为什么必须有（2026-10-17 用户实测）：他先把「每月 19 日」的系列删成
 * 「从这次起往后全部」（写下 `repeatUntil = 2026-11-19`），转头又把规则改成
 * 「每周一」—— 标记还挂着，于是补齐逻辑认为系列已结束，一条周一都不生成。
 * 语义上「改规则」就是重新决定以后怎么重复，旧的结束日当然应当作废。
 *
 * **必须写成字段变更（commit）而不是只改内存**：标记要同步给别的设备，
 * 否则那边仍然按「已结束」跳过，问题只在改了规则的那台机器上消失。
 */
function clearSeriesEnd(root: string): void {
  for (const o of Object.values(state.tasks)) {
    if (!o) continue;
    if (typeof o.repeatUntil !== 'string' || !o.repeatUntil) continue;
    if (seriesRootOf(o) !== root) continue;
    commit('task', o.id, { repeatUntil: null });
  }
}

export function patchTask(id: string, fields: Partial<Task>): void {
  const cur = state.tasks[id];
  if (!cur) return;
  const beforeRepeat = cur.repeat;
  // 改日期时把未定时的位次重算一下，否则会带着旧日期的 order 落到新日期上
  const next: Record<string, unknown> = { ...fields };
  if ('date' in fields && !cur.time && !('order' in fields)) {
    next.order = nextOrder(state, (fields.date ?? null) as string | null);
  }
  commit('task', id, next);
  // 改了重复规则 → 先作废旧的「到此为止」，再重新补齐未来实例（幂等）
  if ('repeat' in fields) {
    const afterRepeat = (fields.repeat ?? null) as RepeatRule | null;
    const changed = !sameRepeat(beforeRepeat, afterRepeat);
    const root = seriesRootOf(cur) ?? id;
    if (changed) clearSeriesEnd(root);
    // 规则变了 = 以后的安排重来一遍：把被旧的「系列结束」清掉的未来空位复活
    ensureRepeatOccurrences({ revive: changed });
  }
}

export function deleteTask(id: string, from = '任务列表'): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: true, deletedAt: Date.now(), trashFrom: from });
}

/**
 * 「只删这一次」—— 删掉某一条重复实例，**系列规则保留**，下一次照常出现。
 *
 * 为什么不直接用 {@link deleteTask}：那样删完之后 `ensureRepeatOccurrences`
 * 下一轮就会用同一个确定性 id（`seriesId#日期`）把它**重新造出来** ——
 * 「只删这次」等于没删。所以额外打一个 `skipped: true`：窗口补齐时遇到
 * 已存在（哪怕已删除）的 id 本来就会跳过，这里只是把这个语义写进数据，
 * 让别的设备 / 组件侧也能看懂「这条是被有意跳过的，不是删失败」。
 *
 * @param date 这一次的发生日 yyyy-MM-dd
 */
export function deleteOne(seriesId: string, date: string, from = '任务列表'): void {
  const id = findOccurrence(seriesId, date);
  if (!id) return;   // 找不到就不动，别默默删错东西
  commit('task', id, {
    deleted: true, deletedAt: Date.now(), trashFrom: from,
    skipped: true,
  });
  // ⚠️ 删的如果正好是**系列根那一次**，系列不能因此死掉 ——
  // ensureRepeatOccurrences 已经改成「按系列归组、组里还有活的就继续」，
  // 所以这里不用额外做什么，但这条注释留着：以后改那儿时别忘了这个前提。
}

/**
 * 找出「属于这个系列、且发生在 date 那一天」的那条任务。
 *
 * ⚠️ **不能直接用 `instanceId(seriesId, date)` 查**（2026-10-14 修）。
 * 那个 id 形状只适用于**派生出来的**实例；**系列根本身是最初建的那条，
 * id 是随机 uuid**。所以用户对根那一天选「只删这一次」时，按 instanceId
 * 查会查不到 → 静默什么都不做（实测 `deleted` 仍是 undefined）。
 */
function findOccurrence(seriesId: string, date: string): string | null {
  const direct = state.tasks[instanceId(seriesId, date)];
  if (direct && !direct.deleted) return direct.id;
  const root = state.tasks[seriesId];
  if (root && !root.deleted && root.date === date) return root.id;
  for (const o of Object.values(state.tasks)) {
    if (!o || o.deleted) continue;
    if (seriesRootOf(o) !== seriesId) continue;
    if (o.date === date) return o.id;
  }
  return null;
}

/**
 * 「从这一次起往后全部」—— 结束这个重复系列。
 *
 * 删掉：系列根 + fromDate 及其之后的**所有**实例。fromDate 之前已完成的历史
 * 保留（用户 2026-10-14 确认过：过去的日子要留痕）。
 *
 * 关键在于**必须连系列根一起处理**：只要根还活着（`repeat.unit !== 'none'`），
 * 窗口补齐就会越过 fromDate 再造出一批未来的 —— 那等于「删了又长出来」。
 * 这里给根打一个 `repeatUntil`：窗口补齐看到它就整个系列跳过。
 *
 * ⚠️ 2026-10-17：收集成员用 seriesRootOf（形状优先），所以被小组件改乱了
 * 血脉的旁支实例（seriesId 指向中间层 / 整个缺失）也一并收进来 —— 旧写法
 * 单路按 seriesId 比对，旁支漏网后过两天又被窗口造回来，正是「选了全部
 * 删除却只删了当天」的根因。
 *
 * ⚠️ 标记尽量写在**系列根**上；根要是本机没有（别的设备建的系列），
 * 就改写在家族里日期最靠前、且能活过这次删除（date < fromDate）的成员上。
 * 写在即将被删的成员上也能生效（墓碑字段会同步、enforceRepeatUntil 认
 * 墓碑），但有能活的载体更稳。
 */
export function deleteSeriesFrom(seriesId: string, fromDate: string, from = '任务列表'): void {
  const now = Date.now();
  const items: Change[] = [];
  const doomed: string[] = [];

  for (const o of Object.values(state.tasks)) {
    if (!o || o.deleted) continue;
    if (seriesRootOf(o) !== seriesId) continue;
    const d = o.date || '';
    if (d >= fromDate) doomed.push(o.id);
  }
  // 根：标上「到此为止」，让窗口补齐不再派生。
  // ⚠️ **根自己可能已经是被删的**（用户先删了根那一次）—— 那时也要把标记写上，
  // 否则分组逻辑看到组里还有活实例，又会把未来的重新造出来。
  const root = state.tasks[seriesId];
  let carrierId: string | null = seriesId;
  if (!root) {
    carrierId = null;
    // 优先：能活过这次删除的存活成员里日期最靠前的
    let best: (typeof state.tasks)[string] | null = null;
    for (const o of Object.values(state.tasks)) {
      if (!o || o.deleted) continue;
      if (seriesRootOf(o) !== seriesId) continue;
      if (!o.date || o.date >= fromDate) continue;
      if (!best || (o.date as string) < (best.date as string)) best = o;
    }
    if (best) carrierId = best.id;
    else if (doomed.length) {
      // 整条家族都在删除范围内：挑日期最靠前的那个墓碑当载体
      let earliest = doomed[0];
      for (const id of doomed) {
        const d = state.tasks[id]?.date || '';
        if (d && (!earliest || d < (state.tasks[earliest]?.date || ''))) earliest = id;
      }
      carrierId = earliest;
    }
  }
  if (carrierId) {
    const carrier = state.tasks[carrierId];
    if (carrier) {
      items.push({ entity: 'task', id: carrierId, calId: carrier.calId, fields: { repeatUntil: fromDate } });
    }
  }
  for (const id of doomed) {
    const o = state.tasks[id];
    items.push({ entity: 'task', id, calId: o.calId, fields: { deleted: true, deletedAt: now, trashFrom: from } });
  }
  if (items.length) commitMany(items);
}

/**
 * 「取消重复」时处理已经铺在日程上的未来实例（用户 2026-10-17）。
 *
 * 场景：用户把一条重复任务改成「不重复」。任务本身要留着（今天还要用），
 * 但**之前已经排进日程的那些未来实例**不能悄悄留着（也不该被静默删掉）——
 * 由用户选：
 *   · `keep`   → 降级成一条条独立任务：清掉重复规则、脱离系列，留在日程上
 *   · `delete` → 打墓碑（进回收站），只留这一次和过去已完成的历史
 *
 * 只动「今天及以后」的实例：过去的发生是历史，删了等于篡改记录。
 * 正在编辑的那一条（`keepId`）**永远不动**。
 */
export function dropRepeatTail(keepId: string, fromDate: string, mode: 'keep' | 'delete'): number {
  const keep = state.tasks[keepId];
  /* 兜底用 keep.id：历史上可能已经把根的 seriesId 摘掉了（2026-10-17 之前
     的「保留」分支会这么干），那 seriesRootOf(根) 会返回 null —— 不兜底的话
     这个函数直接返回 0，用户点「删除这些任务」等于什么都没发生。 */
  const root = (keep ? seriesRootOf(keep) : null) ?? (keep ? keep.id : null);
  if (!root) return 0;

  const items: Change[] = [];
  const now = Date.now();
  let n = 0;
  for (const o of Object.values(state.tasks)) {
    if (!o || o.deleted) continue;
    if (o.id === keepId) continue;                       // 这一条不动
    if (seriesRootOf(o) !== root) continue;
    if (typeof o.date !== 'string' || o.date < fromDate) continue;
    n++;
    items.push({
      entity: 'task', id: o.id, calId: o.calId,
      fields: mode === 'delete'
        ? { deleted: true, deletedAt: now, trashFrom: '取消重复' }
        /* 保留：必须连 `repeat` 一起清空 —— 光摘掉 seriesId 的话，实例身上
           那份旧规则的副本还会让补齐逻辑继续从它派生（等于没取消）。
           ⚠️ **系列根本身例外：绝对不能把它的 seriesId 摘掉**（2026-10-17 晚修）。
           根一旦变成 seriesId=null + repeat=none，`seriesRootOf(根)` 就返回 null
           ——整条家族失去入口。后果是用户之后在这条任务上点 ✕「取消重复 →
           删除这些任务」时，算出来的「后续实例」是空集，于是**只悄悄关掉重复、
           一条都不删**（用户实测：「点了全部删除，它们依然保留着」）。
           根要停派生只需要 repeat=none；身份（seriesId）必须留着。 */
        : { repeat: toRepeat(null, o.date), ...(o.id === root ? {} : { seriesId: null }) },
    });
  }
  if (items.length) commitMany(items);
  return n;
}

/** 这个系列是否已被「从某天起全部删除」结束掉；结束日（不含）之前的仍有效。
 *
 *  ⚠️ 2026-10-17：**全家族扫描**，不限系列根本身。标记可能写在根墓碑上、
 *  也可能写在别的成员上（根不在本机时 deleteSeriesFrom 的改写）。 */
export function seriesEndOf(seriesId: string): string | null {
  let earliest: string | null = null;
  for (const t of Object.values(state.tasks)) {
    if (!t) continue;
    const u = (typeof t.repeatUntil === 'string' && t.repeatUntil) ? t.repeatUntil : null;
    if (u === null) continue;
    if ((seriesRootOf(t) ?? t.id) !== seriesId) continue;
    if (earliest === null || u < earliest) earliest = u;
  }
  return earliest;
}

/**
 * 批量改完成状态（2026-10-14，逾期 / 待办箱 / 已完成 的多选）。
 *
 * 走 {@link toggleTask} 而不是自己 commit：重复任务勾完成时要**顺带派生
 * 下一次**，那条逻辑只在 toggleTask 里。自己写一遍迟早会漏。
 *
 * 已经就是目标状态的不动 —— 既省一次写入，也避免把 `doneAt` 刷成现在。
 * @returns 实际改动的条数
 */
export function batchSetDone(ids: string[], done: boolean): number {
  let n = 0;
  for (const id of ids) {
    const t = state.tasks[id];
    if (!t || t.deleted || t.done === done) continue;
    toggleTask(id);
    n++;
  }
  return n;
}

/**
 * 批量删除（软删除 → 回收站，可还原）。
 *
 * 重复任务在这里**只删被选中的那几次** —— 批量场景下再逐条弹「删这次还是
 * 删以后」太啰嗦。要结束整个系列，单独点开那一条选「从这次起全部」。
 * @returns 实际删除的条数
 */
export function batchDelete(ids: string[], from = '批量删除'): number {
  const items: Change[] = [];
  const now = Date.now();
  for (const id of ids) {
    const t = state.tasks[id];
    if (!t || t.deleted) continue;
    items.push({
      entity: 'task', id, calId: t.calId,
      fields: { deleted: true, deletedAt: now, trashFrom: from },
    });
  }
  if (items.length) commitMany(items);
  return items.length;
}

export function restoreTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: false, deletedAt: null, purged: false });
}

export function purgeTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { purged: true });
}

/**
 * 「不保留」= 留下墓碑（走同步通道，别的设备才知道要删）。
 * 「清空」= 打 purged，服务器快照就不再带它了。两者都是字段写入，没有物理删除。
 */
export function emptyTrash(): void {
  const items: Change[] = [];
  for (const t of trashedTasks(state)) items.push({ entity: 'task', id: t.id, fields: { purged: true } });
  for (const h of trashedHabits(state)) items.push({ entity: 'habit', id: h.id, fields: { purged: true } });
  commitMany(items);
}

/** 把任务挂到项目上（`null` = 摘下来）。归属**只在详情里改**，拖拽不改它 */
export function setTaskProject(taskId: string, projectId: string | null): void {
  if (!state.tasks[taskId]) return;
  commit('task', taskId, { projectId: projectId || null });
}

/**
 * 泳道列之间的移动。`done` 那一列走 `toggleTask`（**不是**直接写 done 字段）——
 * 重复任务要靠它推进系列，绕过它会让「每週一次」这类任务勾完就不见了。
 */
export function setTaskDoing(taskId: string, doing: boolean): void {
  const t = state.tasks[taskId];
  if (!t) return;
  if (t.done) {
    // 从「已完成」列拖出来：先取消完成，再按目标列决定 doing。
    // toggleTask 自己会 commit，这里的 doing 跟随其后 —— 两条 op、两个字段，
    // 顺序无所谓（LWW 是逐字段的，它们不冲突）。
    toggleTask(taskId);
    if (doing) commit('task', taskId, { doing: true });
    return;
  }
  commit('task', taskId, { doing });
}