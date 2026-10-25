// app/tests/lib/probe-env.mjs —— 探针公共环境层（端口 / Chrome / 临时数据目录 / 清理）
// 由 browser-smoke / card-geometry / browser-cards / android-live-check 共用。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function listenFree(srv, preferred) {
  return new Promise((res, rej) => {
    srv.once('error', (e) => {
      if (e.code !== 'EADDRINUSE') return rej(e);
      srv.listen(0, '127.0.0.1', () => res(srv.address().port));
    });
    srv.listen(preferred, '127.0.0.1', () => res(srv.address().port));
  });
}

export async function freePort(preferred) {
  const attempt = (port) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(0));
    s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  if (await attempt(preferred)) return preferred;
  const skip = 1 + (process.pid % 16);
  for (let i = 0; i < 24; i++) { const p = await attempt(preferred + skip + i); if (p) return p; }
  return attempt(0);
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/google/chrome/chrome',
].filter(Boolean);

export const CHROME = process.env.CHROME
  || CHROME_CANDIDATES.find((c) => { try { return spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0; } catch (_) { return false; } });

export async function makePorts(preferred = {}) {
  const api = +(process.env.SMOKE_API_PORT || await freePort(preferred.api || 25701));
  const web = +(process.env.SMOKE_WEB_PORT || await freePort(preferred.web || 5198));
  const cdp = +(process.env.SMOKE_CDP_PORT || await freePort(preferred.cdp || 9223));
  const model = +(process.env.SMOKE_MODEL_PORT || await freePort(preferred.model || 25711));
  return { api, web, cdp, model };
}

export function makeDataDir() {
  return mkdtempSync(path.join(tmpdir(), 'sched-browser-'));
}

export function cleanupDataDir(dataDir) {
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* ignore */ }
}

export function ensureDist(ROOT, DIST, APP_DIR) {
  const idx = path.join(DIST, 'index.html');
  const srcRoots = ['src', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js']
    .map((p) => path.join(APP_DIR, p)).filter(existsSync);
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const r of srcRoots) {
    if (statSync(r).isDirectory()) walk(r); else newest = Math.max(newest, statSync(r).mtimeMs);
  }
  const assetsDir = path.join(DIST, 'assets');
  const injected = existsSync(assetsDir) && readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes('home.xiaokubao.space'));
  const why = !existsSync(idx) ? '不存在'
    : injected ? '是 APK 注基址变体（会绕开临时后端直连生产，必须重建）'
    : newest > statSync(idx).mtimeMs ? '比源码旧' : '';
  if (!why) return;
  console.log(`  [dist] ${why}，自动重建（npm run build）…`);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: APP_DIR, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !existsSync(idx)) {
    throw new Error('dist 重建失败 —— 手动 cd app && npm run build 看报错');
  }
  console.log('  [dist] 重建完成');
}


