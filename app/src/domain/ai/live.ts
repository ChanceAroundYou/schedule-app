/**
 * live.ts —— 消息拼装
 */

import type { AiEvent, AiProposal } from './events.ts';
import { actionText } from './tools.ts';

/**
 * 流式过程中的一条助手气泡。`text` 是**逐字追加**出来的，所以界面拿它
 * 当 key 时要用稳定的 id，不能用下标。
 */
export interface LiveAssistant {
  id: string;
  text: string;
  /** 这一轮调过的工具，动作条用 */
  actions: { name: string; label: string; done: boolean; error?: boolean }[];
  /** 这一轮产生的待确认改动，卡片用。顺序就是模型想改的顺序 */
  proposals: AiProposal[];
  error?: string;
}

export function newLiveAssistant(id: string): LiveAssistant {
  return { id, text: '', actions: [], proposals: [] };
}

/** 把一个流事件并进当前这条助手气泡。返回新的对象（React 要新引用才重渲染） */
export function applyEvent(live: LiveAssistant, ev: AiEvent): LiveAssistant {
  switch (ev.type) {
    case 'text':
      return { ...live, text: live.text + ev.delta };

    case 'proposal': {
      // 按 id 去重。正常一轮里每条只会来一次，但流被重放 / 重连时不该冒出两张
      // 一样的卡片 —— 那样用户会以为有两处改动、确认两遍
      if (live.proposals.some((p) => p.id === ev.proposal.id)) return live;
      return { ...live, proposals: [...live.proposals, ev.proposal] };
    }

    case 'tool': {
      const label = actionText(ev.name, ev.args);
      if (ev.phase === 'start') {
        return { ...live, actions: [...live.actions, { name: ev.name, label, done: false }] };
      }
      // 结束：把最后一条同名且未完成的标成完成 —— 不按下标配对，
      // 因为同一个工具一轮里可能被调两次（模型经常这么干）
      const actions = live.actions.slice();
      for (let i = actions.length - 1; i >= 0; i -= 1) {
        if (actions[i].name === ev.name && !actions[i].done) {
          actions[i] = { ...actions[i], done: true, error: !!ev.isError };
          break;
        }
      }
      return { ...live, actions };
    }
    case 'error':
      return { ...live, error: ev.message };
    default:
      return live;
  }
}
