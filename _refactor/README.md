# _refactor —— React + TypeScript 重构骨架（未启用）

## 这是什么

2026-10-05 上午曾尝试把日程应用重写成 React + TypeScript。这批文件是那次尝试的产物，
**目前完全没有被使用**：根目录的应用仍是原来的纯静态版本，部署走的也是它。

## 状态：半成品，不能跑

已完成的部分只有数据层（约 1279 行）：

| 文件 | 内容 | 状态 |
|---|---|---|
| `src/lib/types.ts` | `Task` / `RepeatRule` / `Habit` / `TrashItem` / `AppState` 类型定义 | 可用 |
| `src/lib/date.ts` | 日期工具，对应原 `store.js` 里的 `U` 对象 | 可用 |
| `src/lib/store.ts` | localStorage 持久化，保留 `schedule-app-v1` key 与重复任务推进 | 可用 |
| `src/lib/parse.ts` | 自然语言解析（日期 / 时间 / 时长 / 重复） | 可用 |
| `src/lib/date.test.ts` | 首个单测 | 未运行过 |
| `package.json` / `vite.config.ts` / `tsconfig.json` | 脚手架，`base` 已设为 `/schedule/` | 未 `npm install` |

**缺的部分**：没有任何 React 组件、没有入口 `main.tsx`、没有 `index.html` 模板、
没有集成测试。`npm run build` 现在必然失败。

## 为什么留着而不是删掉

数据模型是照着已定稿的设计（见 `../CLAUDE.md` 第二节）写的，
是整个重构里最不需要返工的部分。删掉等于白写。

## 下一轮怎么接上

1. 补齐 `src/lib` 的单测，跑通 `npm run test:unit`（账本用的是
   `node --import ./tests/node-resolve-ts.mjs --test src/lib/*.test.ts`，
   需要新建 `tests/node-resolve-ts.mjs` 这个 TS 加载器）
2. React 组件层，按这个顺序：Shell（侧栏 + 顶栏）→ 三视图 → 任务抽屉 → 移动端标签栏
3. 集成测试
4. **把 `../tools/sync-dist.mjs` 换成 `vite build`**

最后一步是关键：只要 `dist/` 这个目录名不变，`../conf.d/home/schedule.conf`
（服务器 `~/docker/nginx/conf.d/home/schedule.conf`）**一行都不用改**，
nginx 会自动开始伺服 React 构建产物。这就是当初把部署产物单独放进 `dist/` 的原因。

## 别做的事

- 不要在根目录跑 `npm install` —— 根目录现在没有 `package.json`
- 不要把这里的文件复制回根目录当作"回退到旧版" —— 旧版是根目录那些 `.js`/`.css`，它一直都在
