#!/usr/bin/env node
/**
 * 生成部署产物 dist/
 *
 * 为什么要有这个脚本：应用是纯静态的，源文件本身就是产物，但**不能把整个项目目录
 * 交给 nginx** —— 里面还有 _refactor/（源码）、DEPLOY.md、CLAUDE.md、tests/ 等，
 * 挂了就是公开可下载。所以用一个白名单把它们挑出来放进 dist/，nginx 只伺服 dist/。
 * 这与「个人账本」工程的做法一致。
 *
 * 将来 React 重构完成后，把下面 FILES + copy 那段换成 `vite build` 即可，
 * dist/ 这个目录名不变，服务器上的 nginx 配置一行都不用改。
 *
 * 零依赖。Node >= 16（账本服务器上是 v22）。用法：node tools/sync-dist.mjs
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist')

/** 部署白名单。少一个文件应用就缺功能，多一个文件就是信息泄露。 */
const FILES = [
  'index.html',
  'styles.css',
  'store.js',
  'parse.js',
  'views.js',
  'clock.js',
  'app.js',
  'sw.js',
  'manifest.json',
  'icon.svg',
]

function main() {
  // 每次全量重建：dist/ 里不该留上一版的残骸（比如删掉的文件）
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const manifest = []
  let bytes = 0

  for (const name of FILES) {
    const src = join(ROOT, name)
    let buf
    try {
      buf = readFileSync(src)
    } catch {
      console.error(`  ✗ 源文件缺失：${name}`)
      process.exitCode = 1
      return
    }
    writeFileSync(join(OUT, name), buf)
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8)
    manifest.push({ name, bytes: buf.length, hash })
    bytes += buf.length
  }

  // 部署清单：留在 dist/ 里，线上排查时能直接确认「服务器上的到底是哪一版」
  writeFileSync(
    join(OUT, 'BUILD.txt'),
    `built-at: ${new Date().toISOString()}\n` +
      `files: ${FILES.length}\n` +
      `total: ${(bytes / 1024).toFixed(1)} KB\n` +
      manifest.map((f) => `  ${f.hash}  ${String(f.bytes).padStart(7)}  ${f.name}`).join('\n') +
      '\n',
  )

  // 索引自检：index.html 引用到的本地资源必须都在 dist/ 里，
  // 少一个就是线上白屏（而且只在浏览器控制台报错，很难第一时间发现）
  const html = readFileSync(join(OUT, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1])
  const missing = refs.filter((r) => !FILES.includes(r))
  if (missing.length) {
    console.error(`  ✗ index.html 引用了不在白名单里的资源：${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log('✓ dist/ 构建完成\n')
  for (const f of manifest) {
    console.log(`  ${f.hash}  ${String(f.bytes).padStart(7)}B  ${f.name}`)
  }
  console.log(`\n  共 ${FILES.length} 个文件，${(bytes / 1024).toFixed(1)} KB`)
  console.log(`  index.html 引用自检通过（${refs.length} 处引用全部命中）`)
  console.log(`  BUILD.txt  ${statSync(join(OUT, 'BUILD.txt')).size}B`)
}

main()
