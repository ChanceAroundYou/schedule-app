/**
 * ai/tools/memory.mjs —— 记忆工具
 *
 * **唯一一个不需要确认的写工具。** 理由：记忆不写进日程、不进 sync 的
 * `changes`，它只影响**以后**的对话，而且用户随时能在界面上删。
 * 反过来说，任何会动到别人能看见的东西的，仍然一律走提案。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import db from '../../db.js';
import { text, fail } from './shared.mjs';

const TYPES = ['preference', 'decision', 'pattern'];

/** 记忆工具 —— agent 自己决定记什么，不需要确认。 */
export function memoryTools({ userId }) {
  return [
    {
      name: 'save_memory',
      label: '记住一件事',
      description:
        '把一条信息记进长期记忆，下次对话还能用。**只在用户表达了偏好、习惯、'
        + '重复模式或关键决定时才记** —— 比如「以后健身放早上」「每周三有例会」'
        + '「10月8日出差，别排事」。不要记流水账。',
      parameters: Type.Object({
        type: Type.String({ description: 'preference | decision | pattern' }),
        content: Type.String({ description: '要记的内容，一句话，用用户的说法' }),
      }),
      execute: async (_id, args) => {
        const type = String(args.type || '').trim();
        if (!TYPES.includes(type)) {
          return fail('type 必须是 preference、decision 或 pattern');
        }
        const content = String(args.content || '').trim();
        if (!content) return fail('content 不能为空');
        if (content.length > 300) return fail('content 太长，一句话就够了');

        db.insertMemory({
          id: randomUUID(),
          userId,
          type,
          content: content.slice(0, 300),
          createdAt: Date.now(),
          lastUsedAt: null,
        });
        // 记完就裁：留最新的 MEMORY_MAX 条（db/memory.js 里的常量）
        db.pruneMemories(userId);

        return {
          content: text({ saved: true, type, content: content.slice(0, 300) }),
          details: {},
        };
      },
    },
  ];
}