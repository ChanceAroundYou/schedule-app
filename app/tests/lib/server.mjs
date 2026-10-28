import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export async function serveDist({ webPort, apiPort, dist, mime, listenFree }) {
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/schedule/dl/version.json')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"versionCode":5,"versionName":"2.0.2","url":"schedule-5.apk","sha256":"stub"}');
      return;
    }
    if (req.url.startsWith('/api/')) {
      const up = fetch(`http://127.0.0.1:${apiPort}${req.url}`, {
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
      });
      up.then(async (r) => {
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      }).catch(() => { res.writeHead(502); res.end('proxy failed'); });
      return;
    }
    /* ⚠️ 先给 URL 补 index.html，**再** path.join（browser-cards.mjs 原先自己写着一条
       注释强调的顺序）。反过来不行：Windows 上 path.join 会把结尾的 '/' 规范化成
       '\\'，于是 `p.endsWith('/')` 判不出来，根路径直接 404 —— 探针在 Windows 上
       表现为「页面空白」，在 Linux 上却好好的。
       （顺带：上一轮改 browser-cards 时对比两份 serveDist 才发现这里顺序是反的，
       已按那份的口径改正。） */
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const p = path.join(dist, rel);
    if (!p.startsWith(dist) || !existsSync(p) || statSync(p).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(p);
    const head = { 'content-type': mime[ext] || 'application/octet-stream' };
    if (ext === '.html' || ext === '.json' || p.endsWith('sw.js')) head['cache-control'] = 'no-store';
    res.writeHead(200, head);
    createReadStream(p).pipe(res);
  });
  const port = await listenFree(srv, webPort);
  return { srv, webPort: port };
}
