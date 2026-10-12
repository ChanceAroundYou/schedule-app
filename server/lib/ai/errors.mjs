/**
 * ai/errors.mjs —— 把工具结果和上游错误翻成给界面看的话
 *
 * 两处都不能整段透传原文：工具结果可能是几万字的 JSON，错误原文可能带着
 * baseUrl 与 key 的片段。所以一个截断到 160 字，一个按模式匹配。
 */

/** 工具结果的摘要 —— 给界面上那条动作条用，不占正文 */
export function summaryOf(result) {
  if (!result) return '';
  const t = (result.content || []).find((c) => c && c.type === 'text');
  if (!t) return '';
  const s = String(t.text).replace(/\s+/g, ' ');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 上游的错误翻成人话。原文可能带 baseUrl / key 片段，所以按模式匹配，不整段透传。 */
export function friendlyError(e) {
  const raw = String((e && e.message) || e || '');
  if (/No API key/i.test(raw)) return '这个模型服务要 API key，去 AI 设置里填一个。';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(raw)) {
    return '连不上模型服务。检查一下 Base URL 填得对不对、那个服务开着没有。';
  }
  if (/40[13]/.test(raw)) return '模型服务拒绝了这次请求（401/403）。检查一下 API key。';
  if (/404/.test(raw)) return '模型服务说没有这个接口或这个模型（404）。检查 Base URL 要不要带 /v1，以及模型名。';
  if (/429/.test(raw)) return '模型服务在限流（429），等一会儿再试。';
  if (/aborted/i.test(raw)) return '已取消。';
  return `模型服务出错了：${raw.slice(0, 200)}`;
}