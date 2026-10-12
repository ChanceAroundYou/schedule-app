/**
 * server.js —— 日程清单后端的**入口**
 *
 * 只提供 /api/*。静态文件交给 nginx（见 ../deploy/schedule.conf），
 * 这样前端构建产物和后端进程各自独立，前端改样式不用重启服务。
 *
 * 启动：
 *   node server.js                 # 默认 127.0.0.1:25692
 *   PORT=8080 node server.js
 *   SCHEDULE_DATA_DIR=/data node server.js
 *
 * 原来这个文件同时装着「有哪些接口」「怎么匹配」「怎么发响应」「定时干什么」，
 * 现在按那四件事拆开，各自一个文件，这个只做**启动顺序**：
 *
 *   config.js      环境变量与落盘路径（require 时求值一次）
 *   http.js        send / readBody / currentUser —— 每条请求都要用的
 *   routes/        接口表，四组（auth · cals · sync · ai）
 *   router.js      路径 → 正则的匹配与那个 http 回调
 *   background.js  两个后台定时器（都不阻塞请求）
 *
 * 业务判断一律不在路由层写 —— 权限尤其（只有 `db.roleOf` / `canWrite` /
 * `canManage` 三个入口）。对外暴露的接口一览见 ../docs/接口.md
 * （及 -日程集 / -同步 / -AI 三份）。
 */
'use strict';

const db = require('./lib/db');
const { DATA_DIR, PORT, HOST, MAX_USERS, loadSecret } = require('./config');
const { createServer } = require('./router');
const { startRevokePruner, startEveningReport } = require('./background');

function main() {
  // 必须最先开库：后面每个定时器、每个 handler 都要它
  db.open(DATA_DIR);
  startRevokePruner();
  startEveningReport();

  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`日程清单后端已启动  http://${HOST}:${PORT}`);
    console.log(`数据目录  ${DATA_DIR}`);
    console.log(`数据库    ${db.file()}`);
    console.log(`账户数    ${db.countUsers()}（开放注册，上限 ${MAX_USERS}）`);
  });

  // 等它真正收完在途请求再关库；超过 3 秒就硬退（挂着不断的是坏连接）
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

// 测试（server/tests/api.test.js）用 createServer 起一个不绑端口的实例
module.exports = { createServer, loadSecret, DATA_DIR };