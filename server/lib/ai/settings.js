/**
 * ai/settings.js —— 模型配置（每人一行，跟账号走）
 *
 * 界面上可改的三样：Base URL、API key、模型名。存在服务器上而不是浏览器里，
 * 理由是这三样要跟着账号走 —— 换台设备登录不该重新填一遍，也不该把 key
 * 落在每台机器的 localStorage 里。
 *
 * **key 只用不回显。** 读接口只回 `hasKey: true/false`，永远不把 key 发回
 * 浏览器（哪怕是自己填的）。改配置时 `apiKey` 字段省略 = 保留原值、
 * 传空串 = 清空。这样「打开设置看一眼」这个动作不会把 key 带到前端，
 * 也不会因为前端没回填而把它清掉。
 *
 * Base URL 是**用户可控、由服务器去请求**的地址，所以这里挡一道 SSRF：
 * 只允许 http/https，且拒绝云元数据那几个众所周知的目标。局域网地址是
 * 故意放行的 —— 本机那个网关就跑在 127.0.0.1 上，把内网一并封掉等于把功能
 * 封掉。这是这个应用「平等多用户 + 开放注册」这个前提下的既定取舍，
 * 单独部署给别人用时应该改成白名单。
 */
'use strict';

const db = require('../db');

/** pi 那边 API 适配器的 id。现在只支持 OpenAI 兼容这一种，留着这列以便后加 */
const DEFAULT_PROVIDER = 'openai-completions';
/** 本机那个 OpenAI 兼容网关。它不需要 key，所以开箱即用 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:25001/v1';
const DEFAULT_MODEL = 'claude-sonnet-5.5';

const MODEL_MAX = 120;
const URL_MAX = 300;
const KEY_MAX = 400;

/**
 * 云厂商的元数据服务地址。这几个人尽皆知且危害最大：
 * 一次请求就能换到实例凭据，而拿到凭据等于拿到那台机器。
 */
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',        // AWS / Azure / GCP / OpenStack
  'metadata.google.internal',
  '100.100.100.200',        // 阿里云
  'metadata.tencentyun.com',
]);

/** 返回错误说明，合法则返回 null */
function baseUrlProblem(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'Base URL 不能为空';
  if (s.length > URL_MAX) return `Base URL 最长 ${URL_MAX} 字`;

  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return 'Base URL 不是合法网址（要带 http:// 或 https://）';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Base URL 只支持 http / https';
  }
  if (BLOCKED_HOSTS.has(u.hostname.toLowerCase())) {
    return '这个地址指向云服务器的元数据服务，不允许访问';
  }
  return null;
}

function modelProblem(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '模型名不能为空';
  if (s.length > MODEL_MAX) return `模型名最长 ${MODEL_MAX} 字`;
  if (/[\u0000-\u001f]/.test(s)) return '模型名含控制字符';
  return null;
}

/**
 * 我当前的配置。没有存过就用默认值（但不落库 —— 用户没改过就不该有行）。
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string|null, updatedAt:number|null, stored:boolean}}
 */
function load(userId) {
  const row = db.getAiSettings(userId);
  if (!row) {
    return {
      provider: DEFAULT_PROVIDER,
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      apiKey: null,
      updatedAt: null,
      stored: false,
    };
  }
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key,
    updatedAt: Number(row.updated_at),
    stored: true,
  };
}

/**
 * 给前端的形状。**绝不包含 apiKey** —— 这是这个函数存在的唯一理由，
 * 别为了「方便」把它加回来。
 */
function publicShape(s) {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    /** 有没有配 key。没配不一定不能用 —— 本机那个网关就不需要 key */
    hasKey: !!s.apiKey,
    ready: !!s.baseUrl && !!s.model,
  };
}

/** @returns {{status:number, body:object}} */
function read(userId) {
  return { status: 200, body: publicShape(load(userId)) };
}

/**
 * 改配置。字段可以只传一部分，没传的保持原值。
 *
 * `apiKey` 的三态：不传 = 保留原值；传空串 = 清空；传值 = 覆盖。
 * 「不传」和「传空」必须区分开，否则前端想只改模型名就会把 key 抹掉。
 *
 * @returns {{status:number, body:object}}
 */
function update(userId, body) {
  const cur = load(userId);
  const next = {
    provider: cur.provider,
    baseUrl: cur.baseUrl,
    model: cur.model,
    apiKey: cur.apiKey,
  };

  if ('baseUrl' in body) {
    const bad = baseUrlProblem(body.baseUrl);
    if (bad) return { status: 400, body: { error: bad } };
    next.baseUrl = String(body.baseUrl).trim();
  }
  if ('model' in body) {
    const bad = modelProblem(body.model);
    if (bad) return { status: 400, body: { error: bad } };
    next.model = String(body.model).trim();
  }
  if ('provider' in body) {
    // 现在只有一种适配器，但列留着 —— 传了不合法的值不如直接说清楚
    const p = String(body.provider || '').trim();
    if (p !== DEFAULT_PROVIDER) {
      return { status: 400, body: { error: `暂时只支持 ${DEFAULT_PROVIDER}` } };
    }
    next.provider = p;
  }
  if ('apiKey' in body) {
    const k = String(body.apiKey == null ? '' : body.apiKey).trim();
    if (k.length > KEY_MAX) return { status: 400, body: { error: `API key 最长 ${KEY_MAX} 字` } };
    next.apiKey = k || null;      // 空串 = 清空
  }

  next.updatedAt = Date.now();
  db.putAiSettings(userId, next);
  return { status: 200, body: publicShape(next) };
}

module.exports = {
  DEFAULT_PROVIDER, DEFAULT_BASE_URL, DEFAULT_MODEL,
  baseUrlProblem, modelProblem,
  load, publicShape, read, update,
};
