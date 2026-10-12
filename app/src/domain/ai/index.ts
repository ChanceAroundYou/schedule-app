/**
 * ai.ts —— AI 对话纯逻辑（桶文件）
 */

export type {
  AiUsage, AiProposal, AiEvent, AiConfirmed, AiChatMessage, AiSessionMeta,
  AiSettings, AiSettingsPatch, AiMemory, AiHistoryItem, AiAuthorizations,
} from './events.ts';
export { sseFeed } from './sse.ts';
export { actionText, proposalText } from './tools.ts';
export { buildContext } from './context.ts';
export type { LiveAssistant } from './live.ts';
export { newLiveAssistant, applyEvent } from './live.ts';
