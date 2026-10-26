/**
 * lib/media.js —— 详细内容里那些图片的落盘与读回
 *
 * 为什么存本机而不是对象存储：这个后端是**单机 + 零依赖**的一台 NAS 进程，
 * 数据都在 `~/.local/schedule/data/`，备份就是打这个目录。多接一个云盘等于
 * 多一个会挂、会欠费、还要配密钥的东西，收益只是「换台机器也能读」——
 * 而这个应用本来就只跑在一台机器上。
 *
 * **文件名就是内容哈希**（sha256），好处三条：
 *   1. 同一张图贴十次只占一份；
 *   2. 名字猜不出来，所以公开读（`<img>` 带不了 Bearer 头）是安全的；
 *   3. 天然幂等：重复上传不覆盖、不改 mtime，缓存也不会失效。
 *
 * 代价是**改图必然产生新文件**（压缩、换格式都算），旧文件会变成没人引用的
 * 孤儿。容量上限在那儿兜着，清理见 `orphans()`。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MEDIA_DIR, MEDIA_FILE_MAX, MEDIA_TOTAL_MAX } = require('../config');

/** 收哪些类型。**不收 svg** —— 它能带脚本，而这里是「公开可读」的路径 */
const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const NAME_RX = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

function ensureDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/* 总量统计要 readdir + stat 上千个文件，每次上传都干一遍太浪费。
   缓 60 秒 —— 上限是 500MB，一分钟内多存几 MB 不影响判断。 */
let cached = { at: 0, bytes: 0, count: 0 };

function stats() {
  if (Date.now() - cached.at < 60 * 1000) return cached;
  let bytes = 0;
  let count = 0;
  try {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      if (!NAME_RX.test(name)) continue;
      try { bytes += fs.statSync(path.join(MEDIA_DIR, name)).size; count += 1; } catch (_) { /* 并发删了 */ }
    }
  } catch (_) { /* 目录还不存在 = 空的 */ }
  cached = { at: Date.now(), bytes, count };
  return cached;
}

/**
 * 存一张图。**只返回文件名**，URL 由路由层拼（前缀随部署变，库里只存相对路径，
 * 这样换域名 / App 换基址都不会把已存的图写死成旧地址）。
 *
 * @returns {{ ok: true, name: string, size: number } | { ok: false, status: number, error: string }}
 */
function save(buf, mime) {
  const ext = EXT_OF[String(mime || '').toLowerCase().split(';')[0].trim()];
  if (!ext) return { ok: false, status: 415, error: '只支持 PNG / JPEG / WebP / GIF 图片' };
  if (!buf || !buf.length) return { ok: false, status: 400, error: '图片内容是空的' };
  if (buf.length > MEDIA_FILE_MAX) {
    return { ok: false, status: 413, error: `单张图片不能超过 ${Math.round(MEDIA_FILE_MAX / 1024 / 1024)}MB` };
  }
  const total = stats();
  if (total.bytes + buf.length > MEDIA_TOTAL_MAX) {
    return { ok: false, status: 507, error: '图片存储已满，请清理旧任务里的图片' };
  }

  const name = crypto.createHash('sha256').update(buf).digest('hex') + '.' + ext;
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file)) {
    ensureDir();
    /* 先写临时名再 rename：进程在写一半时被杀掉，不会留下半张图冒充完整文件
       （内容哈希的文件名会让「半个文件」永远被当成命中，从此这张图永远是坏的）。 */
    const tmp = file + '.' + process.pid + '.part';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    cached = { at: 0, bytes: 0, count: 0 };
  }
  return { ok: true, name, size: buf.length, url: '/api/media/' + name };
}

/** 名字合法才去碰磁盘 —— 这一步挡住 `../` 之类的路径穿越 */
function isName(name) {
  return NAME_RX.test(name);
}

function filePath(name) {
  return path.join(MEDIA_DIR, name);
}

function mimeOf(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return MIME_OF[ext] || 'application/octet-stream';
}

/** 目录里所有图的名字（清理脚本用） */
function list() {
  try {
    return fs.readdirSync(MEDIA_DIR).filter((n) => NAME_RX.test(n));
  } catch (_) {
    return [];
  }
}

/** 删掉指定名字的图。返回删了几个 */
function remove(names) {
  let n = 0;
  for (const name of names) {
    if (!isName(name)) continue;
    try { fs.unlinkSync(filePath(name)); n += 1; } catch (_) { /* 已经不在了 */ }
  }
  if (n) cached = { at: 0, bytes: 0, count: 0 };
  return n;
}

module.exports = { save, isName, filePath, mimeOf, list, remove, stats };
