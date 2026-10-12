/**
 * ai.ts —— AI 相关 API
 */

import type {
  AiAuthorizations, AiChatMessage, AiConfirmed, AiHistoryItem,
  AiMemory, AiSessionMeta, AiSettings, AiSettingsPatch,
} from '../../domain/ai.ts';
import { req } from './request.ts';

export const ai = {
  aiSettings: () => req<AiSettings>('GET', 'ai/settings'),

  /**
   * 改配置。**`apiKey` 不传 = 保留原值**（服务端的三态），所以设置浮层
   * 提交时只带用户真动过的字段，别图省事把整份配置回传 —— 那会把 key 抹掉。
   */
  aiSaveSettings: (patch: AiSettingsPatch) => req<AiSettings>('PUT', 'ai/settings', patch),

  aiSessions: () =>
    req<{ sessions: AiSessionMeta[] }>('GET', 'ai/sessions').then((r) => r.sessions),

  aiSession: (id: string) =>
    req<{ session: AiSessionMeta; messages: AiChatMessage[] }>(
      'GET', `ai/sessions/${encodeURIComponent(id)}`, undefined,
    ),

  /**
   * 确认一批提案 —— 这才是 AI 真正改数据的那一步。
   *
   * **只回传 id，不回传要改什么。** 服务端按 id 从库里把当时存的提案读回来，
   * 再查一遍权限。故意这么设计：参数从浏览器回传的话，前端能改的东西
   * 别人也能改，权限判断就落到了浏览器手里。
   */
  aiConfirm: (ids: string[]) =>
    req<{ done: AiConfirmed[]; failed: { id: string; reason: string }[] }>(
      'POST', 'ai/confirm', { ids },
    ),

  aiDeleteSession: (id: string) =>
    req<{ ok: boolean }>('DELETE', `ai/sessions/${encodeURIComponent(id)}`),

  /* ---- 记忆 ---- */

  aiMemories: () =>
    req<{ memories: AiMemory[] }>('GET', 'ai/memory').then((r) => r.memories),

  aiDeleteMemory: (id: string) =>
    req<{ ok: boolean }>('DELETE', `ai/memory/${encodeURIComponent(id)}`),

  aiUpdateMemory: (id: string, content: string) =>
    req<{ ok: boolean }>('PUT', `ai/memory/${encodeURIComponent(id)}`, { content }),

  /* ---- 操作历史 ---- */

  aiHistory: (aiOnly = false) =>
    req<{ history: AiHistoryItem[] }>(
      'GET', `ai/history${aiOnly ? '?aiOnly=1' : ''}`,
    ).then((r) => r.history),

  /* ---- 授权 ---- */

  aiAuthorizations: () =>
    req<AiAuthorizations>('GET', 'ai/authorizations'),

  aiSaveAuthorizations: (patch: Partial<AiAuthorizations>) =>
    req<AiAuthorizations>('PUT', 'ai/authorizations', patch),
};
