/**
 * config.js —— 环境变量、落盘路径与签名密钥
 *
 * 拆出来的理由只有两个：这些是**进程级**的（读一次、之后所有 handler 都靠它），
 * 不该和路由挤在一个文件里；以及 `loadSecret()` 有副作用（会建目录写文件），
 * 放在 server.js 顶部时它跟「建 http 服务」读起来像一件事，其实是两件。
 *
 * 全部在 **require 时**求值一次，之后拿到的就是常量 —— 不要改成运行时再读
 * `process.env`：限流和请求体上限都是下面这些常量在把关，中途改掉会让
 * 「已经按旧值判过的请求」和后面的不一致。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.SCHEDULE_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 25692);
const HOST = process.env.HOST || '127.0.0.1';

/** 首次导入历史数据可能一次推几千条 op */
const MAX_BODY = 16 * 1024 * 1024;

/* ---------- 详细内容里的图片（2026-10-26） ----------
 *
 * 只存**压缩后**的图：前端在上传前用 canvas 重编码（长边 2560、质量 0.82），
 * 一张手机截图从 3MB 掉到 200~400KB。所以这两个上限是给「万一有人绕过前端
 * 直接打接口」留的护栏，不是给正常使用卡的 —— 卡太小会让正常截图传不上去。
 *
 * 落在 data/media 下，跟 schedule.db 同一个 data 目录，**备份必须带上它**，
 * 否则恢复之后所有图全裂。
 */
const MEDIA_DIR = process.env.SCHEDULE_MEDIA_DIR || path.join(DATA_DIR, 'media');
/** 单个文件上限。前端压完通常 0.4MB，6MB 够放没压过的长截图 */
const MEDIA_FILE_MAX = 6 * 1024 * 1024;
/** 总量上限。1500~2000 张压缩图，家庭场景几年用不完 */
const MEDIA_TOTAL_MAX = 500 * 1024 * 1024;


/** 一次问 AI 的字数上限。够写一大段话了，再长基本是粘错了东西 */
const TEXT_MAX = 4000;

/** 自助注册是开放的，给个上限，免得被刷成垃圾账户库。家庭场景用不到 200 */
const MAX_USERS = Number(process.env.MAX_USERS || 200);

/**
 * 签名密钥落盘保存。每次重启重新生成的话，所有已签发的 token 会集体失效，
 * 表现是「用着用着突然被登出」。
 */
function loadSecret() {
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_) { /* 首次运行，下面生成 */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const SECRET = loadSecret();

module.exports = {
  DATA_DIR, PORT, HOST, MAX_BODY, TEXT_MAX, MAX_USERS,
  MEDIA_DIR, MEDIA_FILE_MAX, MEDIA_TOTAL_MAX,
  SECRET, loadSecret,
};
