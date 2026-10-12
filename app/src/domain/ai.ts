/**
 * ai.ts —— AI 对话里那些**可以脱离浏览器测**的部分（桶文件）
 *
 * 实现拆在同目录的七个文件里，这里只 re-export。**公开 API 与拆分前逐字相同**。
 *
 * 本目录**保持纯净**（不含 React / DOM / 网络）—— 它由 `domain/ai.test.ts`
 * 直接在 Node 里跑。
 */

export * from './ai/index.ts';