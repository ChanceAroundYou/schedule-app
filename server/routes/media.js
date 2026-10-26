/**
 * routes/media.js —— 详细内容里的图片：一个上传、一个读
 *
 * 只有两条，`app/api/media.ts` 是它们唯一的调用方。设计上的三个决定：
 *
 *   1. **请求体是裸二进制，不是 multipart。** 服务端零依赖、不引 formidable
 *      之类的解析器；前端直接把压缩后的 Blob 当 body 发上来，`Content-Type`
 *      就是图片 MIME。router.js 为此给这条路由开了 `RAW_KEYS` 例外（那边
 *      默认把所有 body 当 JSON 解析）。
 *   2. **GET 不鉴权。** `<img src>` 带不了 `Authorization` 头，而这里的文件名
 *      是内容 sha256，猜不到；收的又只有位图（不收 svg）。要更强可以加签名
 *      过期参数，代价是每条 img 都得在渲染时重算 —— 这个应用不值得。
 *   3. **只返回相对路径**（`/api/media/<hash>.png`）。换域名、App 换基址时
 *      已存的图不会写死成旧地址；补全前缀是前端渲染时的事。
 */
'use strict';

const fs = require('node:fs');

const media = require('../lib/media');

module.exports = {

  /** 上传（前端已经压过一遍，这里只做兜底校验） */
  'POST /api/media': (ctx) => {
    if (!Buffer.isBuffer(ctx.body)) {
      return { status: 400, body: { error: '图片请求体必须是二进制' } };
    }
    const out = media.save(ctx.body, ctx.req.headers['content-type']);
    if (!out.ok) return { status: out.status, body: { error: out.error } };
    return { status: 200, body: { url: out.url, size: out.size } };
  },

  /**
   * 读。命中就是文件流出去，不命中 404 —— **不区分「名字非法」和「不存在」**，
   * 免得有人拿返回的差异去探目录里有什么。
   */
  'GET /api/media/:name': (ctx) => {
    const name = ctx.params.name;
    if (!media.isName(name)) {
      ctx.res.writeHead(404);
      ctx.res.end();
      return { raw: true };
    }
    let buf;
    try {
      buf = fs.readFileSync(media.filePath(name));
    } catch (_) {
      ctx.res.writeHead(404);
      ctx.res.end();
      return { raw: true };
    }
    ctx.res.writeHead(200, {
      'Content-Type': media.mimeOf(name),
      'Content-Length': buf.length,
      /* 名字就是内容哈希 ⇒ 内容永不变 ⇒ 可以永久缓存 */
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(buf);
    return { raw: true };
  },
};
