/**
 * routes/index.js —— 把手里的几组处理器合成一张表
 *
 * 拆成四组（auth / cals / sync / ai）是为了单文件不超过 200 行，
 * **对外仍然只是一张 `handlers` 表** —— router.js 只认这一张，加路由也只改这里。
 *
 * 键就是 `'METHOD /api/path'`，router.js 直接拿它当表名、拿它去编译正则。
 * **重复的键在这里会当场炸**，因为静默覆盖比启动失败难查得多：
 * 一个人往 auth 组里加了 `POST /api/me`，另一个人已经在 cals 组里加过一条，
 * 谁也不知道最后活的是哪条。
 */
'use strict';

const auth = require('./auth');
const cals = require('./cals');
const sync = require('./sync');
const ai = require('./ai');
const widget = require('./widget');
const media = require('./media');

const handlers = {};

// widget 是给桌面小组件（原生侧）用的两个接口，独立成组：
// 它跑在 Java/HttpURLConnection 上，没有 localStorage、跑不了同步引擎，
// 不能直接复用 /api/sync 那套游标+outbox 语义。
//
// media 是详细内容里的图片（2026-10-26），请求体是裸二进制而不是 JSON ——
// router.js 里有一张 `RAW_KEYS` 表专门标这类路由，加新的记得同步过去。
for (const [group, mod] of [['auth', auth], ['cals', cals], ['sync', sync], ['ai', ai], ['widget', widget], ['media', media]]) {
  for (const key of Object.keys(mod)) {
    if (handlers[key]) {
      throw new Error(`路由重复：${key}（${group} 组与前面某一组撞了）`);
    }
    handlers[key] = mod[key];
  }
}

module.exports = { handlers };