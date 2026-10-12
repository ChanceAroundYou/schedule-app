/**
 * ai/tools/write.mjs —— 写入工具（**只造提案，一行都不写库**）
 *
 * 为什么不写：写下去就没人能撤了。AI 理解错一句话，用户的日程就变了，
 * 而且它还会出现在别的设备上 —— 用户要找回来得进垃圾箱翻。
 * 所以这条路是「模型调工具 → 工具只记一条提案 → 用户点确认 → 才真写」。
 *
 * 三道闸，缺一不可：
 *
 *   1. **提示词**（prompt.mjs）说「先提案」，软的，管住模型的措辞；
 *   2. **这里**：写工具根本没有写的能力，模型再想直接改也改不了；
 *   3. **`POST /api/ai/confirm`** 才是唯一真的落库点，它在写之前
 *      **重新查一遍权限** —— 提案生成到确认之间，用户可能被降级或被移出那个集。
 *      （换成「信客户端回传的参数」就是把权限判断交给了浏览器。）
 *
 * ## 提案里存什么
 *
 * 存的是 `fields` —— **最终要落进 op 的那些字段**，不是「意图」。
 * 确认那一步因此完全不认识 kind、也不认识下面这些工具：它只管再查一次权限、
 * 给这批字段套上 deviceId='ai'、发一批 op。
 * 两边共用一份数据结构，就不会出现「工具改了、确认那边忘了跟着改」。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { isIsoDate, today, minutesOfTime } from '../dates.mjs';
import {
  NOTE_MAX, TITLE_MAX, DURATION_MIN, DURATION_MAX,
  text, fail, findTask, findHabit, calendars, sync,
} from './shared.mjs';

export const WRITE_TOOL_NAMES = [
  'create_task', 'update_task', 'complete_task', 'reschedule_task', 'delete_task',
  'create_habit', 'checkin_habit', 'delete_habit',
];

const isTime = (s) => minutesOfTime(s) != null;

/** 5 分钟步进，跟时间轴上拉伸的手感一致 */
function clampDuration(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(n / 5) * 5));
}

/**
 * 要写进哪个日程集。
 *
 * 模型经常不传 calId（它可能压根没先调 list_calendars）。只有一个可写的集时
 * 直接用那个 —— 家庭场景里这是绝大多数情况；有多个就让它指定，
 * **不能替它挑一个**：挑错了是把任务默默塞进别人的集。
 */
function pickCal(userId, raw) {
  const mine = calendars.listMine(userId);
  if (raw) {
    const hit = mine.find((c) => c.id === String(raw));
    if (!hit) return { error: `没有这个日程集：${raw}。先调 list_calendars 看看有哪些。` };
    if (!calendars.canWrite(hit.role)) return { error: `「${hit.name}」你只有查看权限，改不了里面的东西` };
    return { cal: hit };
  }
  const ok = mine.filter((c) => calendars.canWrite(c.role));
  if (!ok.length) return { error: '你没有任何可以改的日程集' };
  if (ok.length > 1) {
    return { error: `你手上有多个可写的日程集，得指定 calId：${ok.map((c) => `${c.name}=${c.id}`).join('、')}` };
  }
  return { cal: ok[0] };
}

/**
 * 记一条提案，回给模型一句「已记下」。
 *
 * 返回的是**成功**结果（isError 为假）：模型调工具这件事本身做对了，
 * 只是改动落在「等确认」这个状态里。回 isError 的话它会以为工具坏了、反复重试。
 */
function propose(proposals, toolCallId, p) {
  const proposal = {
    id: String(toolCallId),
    kind: p.kind,
    calId: p.calId,
    calName: p.calName,
    entity: p.entity || 'task',
    entityId: p.entityId,
    title: p.title,
    fields: p.fields,
  };
  proposals.set(proposal.id, proposal);
  return {
    content: text({
      pending: true,
      kind: proposal.kind,
      cal: proposal.calName,
      title: proposal.title,
      changes: proposal.fields,
      note: '已记为待确认提案，数据库里**还没有**任何改动。'
        + '用一句话说清你打算改什么、改到哪天，然后等用户点确认 —— 不要说「已经改好了」。',
    }),
    details: { proposal },
  };
}

/**
 * 造一批写入工具。
 *
 * @param {{userId:string, proposals:Map<string,object>}} ctx
 *   `proposals` 是这一轮的提案收集器：工具的 `execute` 往它里面塞，
 *   chat.mjs 再按 **toolCallId** 把它们挂到对应的 assistant 消息上落库。
 *   按 toolCallId 而不是按顺序，是因为 pi 默认**并行**执行同一轮的多个工具，
 *   回来的顺序和消息里 toolCall 块的顺序可以不一样。
 */
export function writeTools({ userId, proposals }) {
  return [

    {
      name: 'create_task',
      label: '建一条任务',
      description:
        '新建一条任务。**调用它不会真的建** —— 只会记成一条待确认提案，用户点了确认才落库。'
        + 'date 省略 = 放进待办箱（还没定哪天）；date 有、time 省略 = 那天的事，但不定时间。'
        + '你不确定用户想放哪天时，先问清楚再调，别自己猜一个日期。',
      parameters: Type.Object({
        title: Type.String({ description: '任务标题，用用户的说法，尽量短' }),
        date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，省略 = 待办箱' })),
        time: Type.Optional(Type.String({ description: 'HH:MM，省略 = 那天不定时' })),
        duration: Type.Optional(Type.Number({ description: '要多久，分钟，默认 60' })),
        note: Type.Optional(Type.String({ description: '备注，可省' })),
        calId: Type.Optional(Type.String({ description: '放进哪个日程集，省略 = 你唯一的那个可写集' })),
        repeat: Type.Optional(Type.Object({
          unit: Type.Optional(Type.String({ description: 'none|day|week|month|year，默认 none' })),
          n: Type.Optional(Type.Number({ description: '每 n 个 unit，默认 1' })),
        })),
      }),
      execute: async (toolCallId, args) => {
        const title = String(args.title || '').trim();
        if (!title) return fail('title 不能为空');

        const date = args.date ? String(args.date) : null;
        if (date && !isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);
        const time = args.time ? String(args.time) : null;
        if (time && !isTime(time)) return fail(`time 不是 HH:MM：${time}`);

        const r = pickCal(userId, args.calId);
        if (r.error) return fail(r.error);

        // 重复规则。模型只给 unit 和 n，其余字段由这里补全。
        let repeat = null;
        if (args.repeat && args.repeat.unit && args.repeat.unit !== 'none') {
          const unit = String(args.repeat.unit);
          const n = Math.max(1, Math.min(365, Number(args.repeat.n) || 1));
          const day = date ? Number(date.slice(8, 10)) : 1;
          repeat = { unit, n, weekdays: [], monthday: day, end: null };
        }

        return propose(proposals, toolCallId, {
          kind: 'create',
          calId: r.cal.id,
          calName: r.cal.name,
          // id 在提案时就定下来。确认那一步因此不需要生成任何东西，
          // 卡片上显示的就是最终那条任务的 id
          entityId: randomUUID(),
          title: title.slice(0, TITLE_MAX),
          fields: {
            title: title.slice(0, TITLE_MAX),
            note: String(args.note || '').slice(0, NOTE_MAX),
            date,
            time,
            duration: clampDuration(args.duration),
            repeat,
            createdAt: Date.now(),
            source: 'ai',
          },
        });
      },
    },

    {
      name: 'update_task',
      label: '改一条任务',
      description:
        '改一条任务的标题 / 备注 / 日期 / 时间 / 时长。**只传要改的那几项**，没传的保持不动。'
        + 'date 传空串 = 挪回待办箱；time 传空串 = 清掉时间。'
        + '**调用它不会真的改**，只会记成待确认提案。'
        + 'id 要用 list_tasks / search_tasks 结果里的 id，不要自己编。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        title: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        date: Type.Optional(Type.String({ description: 'YYYY-MM-DD；空串 = 挪回待办箱' })),
        time: Type.Optional(Type.String({ description: 'HH:MM；空串 = 清掉时间' })),
        duration: Type.Optional(Type.Number({ description: '分钟' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}。用 list_tasks 或 search_tasks 拿准确的 id。`);

        const fields = {};
        const bad = fillFields(fields, args, cur.raw);
        if (bad) return fail(bad);
        if (!Object.keys(fields).length) return fail('没说要改什么');

        return propose(proposals, toolCallId, {
          kind: 'update',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: fields.title || cur.raw.title,
          fields,
        });
      },
    },

    {
      name: 'complete_task',
      label: '标完成 / 取消完成',
      description:
        '把一条任务标成做完（done=true）或改回没做（done=false）。**只记提案，不落库。**'
        + '重复任务不行 —— 勾完成会顺带推出下一次，那套推算在客户端里，'
        + '让它用应用界面勾，别绕。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        done: Type.Boolean({ description: 'true = 做完了，false = 改回没做' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);
        if (typeof args.done !== 'boolean') return fail('done 得是 true 或 false');

        const r = cur.raw.repeat;
        if (r && r.unit && r.unit !== 'none') {
          return fail('这是一条重复任务。勾完成要顺带推出下一次，那套推算只在客户端里 —— '
            + '请让用户在应用里勾，不要改它的 done。');
        }

        const done = args.done;
        return propose(proposals, toolCallId, {
          kind: done ? 'complete' : 'uncomplete',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { done, doneAt: done ? Date.now() : null },
        });
      },
    },

    {
      name: 'reschedule_task',
      label: '给一条任务改期',
      description:
        '把一条任务挪到别的日期 / 时间。**只记提案，不落库。**'
        + 'time 省略 = 挪到那天但不定时间；date 必须有，'
        + '要挪回待办箱请用 update_task 传空 date。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        date: Type.String({ description: '挪到哪天，YYYY-MM-DD' }),
        time: Type.Optional(Type.String({ description: 'HH:MM，省略 = 那天不定时' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);

        const date = String(args.date || '');
        if (!isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);
        const time = args.time ? String(args.time) : null;
        if (time && !isTime(time)) return fail(`time 不是 HH:MM：${time}`);

        const fields = { date, time };
        // 未定时的任务靠 order 在「同一天」里排位次，而旧位次是属于旧日期的：
        // 留着会和那天已有的任务撞号，排序变得不稳定。清掉 = 排在那组最后。
        if (!time) fields.order = null;

        return propose(proposals, toolCallId, {
          kind: 'reschedule',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields,
        });
      },
    },

    {
      name: 'delete_task',
      label: '删一条任务',
      description:
        '删一条任务。**只记提案，不落库**，而且删是**软删除** —— 它会进垃圾箱，'
        + '垃圾箱里那行会写着「从 AI 删的」，用户随时能还原。'
        + '用户说「删掉」时先确认是哪一条，别把名字像的都删了。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);

        return propose(proposals, toolCallId, {
          kind: 'delete',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          // trashFrom 是垃圾箱那行「从哪删的」的来源（store.deleteTask 的第二个参数）。
          // 写 'AI' 是为了让用户事后看得出来这次不是自己删的
          fields: { deleted: true, deletedAt: Date.now(), trashFrom: 'AI' },
        });
      },
    },

    // ---- 打卡（需确认）----

    {
      name: 'create_habit',
      label: '建一个打卡项',
      description:
        '新建一个打卡项（比如「每天喝水」「每天读书」）。**只记提案，不落库。**'
        + '打卡项不属于日程集，是全局的。',
      parameters: Type.Object({
        title: Type.String({ description: '打卡项名称，用用户的说法' }),
      }),
      execute: async (toolCallId, args) => {
        const title = String(args.title || '').trim();
        if (!title) return fail('title 不能为空');

        return propose(proposals, toolCallId, {
          kind: 'create',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: randomUUID(),
          title: title.slice(0, TITLE_MAX),
          fields: {
            title: title.slice(0, TITLE_MAX),
            order: Object.keys(sync.snapshot(userId).habits).length,
            log: {},
            createdAt: Date.now(),
            source: 'ai',
          },
        });
      },
    },

    {
      name: 'checkin_habit',
      label: '打卡',
      description:
        '给一个打卡项打卡（标记今天完成了）。**只记提案，不落库。**'
        + 'id 要用 list_tasks 或 search_tasks 结果里的 id。',
      parameters: Type.Object({
        id: Type.String({ description: '打卡项 id' }),
        date: Type.Optional(Type.String({ description: '哪天，YYYY-MM-DD，默认今天' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findHabit(userId, args.id);
        if (!cur) return fail(`找不到这个打卡项：${args.id}`);

        const date = args.date ? String(args.date) : today();
        if (!isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);

        return propose(proposals, toolCallId, {
          kind: 'checkin',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { log: { ...cur.raw.log, [date]: true } },
        });
      },
    },

    {
      name: 'delete_habit',
      label: '删一个打卡项',
      description:
        '删一个打卡项。**只记提案，不落库**，删是软删除 —— 它会进垃圾箱。',
      parameters: Type.Object({
        id: Type.String({ description: '打卡项 id' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findHabit(userId, args.id);
        if (!cur) return fail(`找不到这个打卡项：${args.id}`);

        return propose(proposals, toolCallId, {
          kind: 'delete',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { deleted: true, deletedAt: Date.now(), trashFrom: 'AI' },
        });
      },
    },
  ];
}

/**
 * 把 `update_task` 传进来的字段翻成 op 字段，只认**真的传了**的那几个。
 *
 * 单独拆出来是因为「没传」和「传了空串」必须分开：没传 = 不动，
 * 传空串 = 清掉（把日期清掉就是挪回待办箱）。用 `??` 一律兜默认值就会把
 * 「没传」当成「清空」，用户改个标题顺手把日期抹了。
 *
 * @returns {string|null} 参数有问题时返回原因
 */
function fillFields(fields, args, cur) {
  if (args.title !== undefined) {
    const v = String(args.title).trim();
    if (!v) return 'title 不能改成空的（要删就用 delete_task）';
    fields.title = v.slice(0, TITLE_MAX);
  }
  if (args.note !== undefined) fields.note = String(args.note).slice(0, NOTE_MAX);

  if (args.date !== undefined) {
    const d = String(args.date);
    if (!d) fields.date = null;
    else if (!isIsoDate(d)) return `date 不是 YYYY-MM-DD：${d}`;
    else fields.date = d;
  }
  if (args.time !== undefined) {
    const t = String(args.time);
    if (!t) fields.time = null;
    else if (!isTime(t)) return `time 不是 HH:MM：${t}`;
    else fields.time = t;
  }
  if (args.duration !== undefined) fields.duration = clampDuration(args.duration);

  // 换了一天、而这条又是未定时的 —— 旧 order 属于旧日期，得清掉（同 reschedule_task）
  const effTime = ('time' in fields) ? fields.time : (cur.time || null);
  if ('date' in fields && !effTime) fields.order = null;
  return null;
}