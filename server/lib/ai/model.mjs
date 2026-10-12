/**
 * ai/model.mjs —— 用户填的那几个值 → pi 的 Model
 *
 * 抽出来的理由是它有**实测结论**在里面（下面 compat 那三条），必须有个固定的
 * 地方放着，别在改别的东西时顺手碰掉。
 *
 * `buildModel` 同时供 `runChat` 与注入假 `streamFn` 的测试使用 —— **测试必须
 * 拿到和真跑一模一样的 Model**，否则测出来的行为对不上真的。
 */
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';

/**
 * 用户没填 key 时递给 pi 的占位符。
 *
 * **不能传 undefined**：pi 会先做一次「有没有 key」的检查，没有就直接返回
 * `stopReason: 'error' / errorMessage: 'No API key for provider: …'` ——
 * 请求根本没发出去。而本机那个网关（以及 Ollama / vLLM / LM Studio 这一类）
 * 本来就不校验 key，空着是合法配置。给个占位符让它照常发。
 *
 * 真需要 key 的服务会拿着这个占位符去鉴权、拿到 401，那条错误更有用：
 * 它会走到 errors.mjs 的 friendlyError，告诉用户「检查一下 API key」。
 */
export const NO_KEY = 'not-needed';

/**
 * 用户配的那几个值 → pi 的 Model。
 *
 * `compat` 三个开关是**实测出来的**，不是抄的：
 * - `supportsDeveloperRole: false` —— 本机这个网关（Copilot 代理）不认 `developer` 角色
 * - `supportsReasoningEffort: false` —— 同上，不认 `reasoning_effort`
 * - `maxTokensField: 'max_tokens'` —— 不写这个会**同时**发 `max_tokens` 和
 *   `max_completion_tokens`，上游直接 400「两个不能一起给」。
 *   pi 对未知 baseUrl 的默认推断是 `max_completion_tokens`，正好撞上。
 *
 * `cost` 全 0：这里算不出钱（用户可能接的是任意网关）。填假数字反而会让
 * 界面上出现一个看起来精确的错误金额。
 */
export function buildModel(s) {
  return {
    id: s.model,
    name: s.model,
    api: 'openai-completions',
    provider: 'openai-completions',
    baseUrl: s.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  };
}

/**
 * 真模型。apiKey 只能从 stream 选项传 —— Model 上没有这个字段。
 *
 * 模型实例由调用方（agent 的 initialState）持有并回传，这里只补 key 和选项，
 * 不自己再 build 一份 —— 否则「注入了假 streamFn」和「真模型」两条路上
 * agent 拿到的 Model 会是两个对象，测出来的行为对不上真的。
 */
export function realStreamFn(cfg) {
  return (m, context, options) =>
    streamSimple(m, context, { ...options, apiKey: cfg.apiKey || NO_KEY });
}