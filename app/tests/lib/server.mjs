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
    let p = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (process.platform === 'win32' ? p.endsWith('\\') : p.endsWith('/')) p += 'index.html';
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
