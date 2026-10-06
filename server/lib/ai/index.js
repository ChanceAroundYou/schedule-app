/**
 * ai/index.js —— ESM 那一半的 CJS 入口
 *
 * `@earendil-works/pi-*` 是 **ESM only**（`type: module`，exports 里只有
 * `import` 条件，没有 `require`）。后端主体是 CommonJS，所以：
 *
 * - 需要 pi 的东西写 `.mjs`（tools / prompt / chat / sse / dates）
 * - 这个文件是 CJS，用动态 `import()` 把它们拉进来
 * - **不是 NODE_PATH 那条路**：NODE_PATH 对 ESM 的 `import()` 不生效，
 *   实测报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。真正让它解析到的是
 *   `node_modules` 符号链接（见 deploy/install-deps.sh）
 *
 * 做成**惰性 + 缓存**而不是启动时 import：pi 起不来时（依赖没装、装坏了），
 * 只有 AI 那几个端点报错，登录、同步、日历全都照常 —— 一个可选功能的依赖
 * 不该让整个后端起不来。
 */
'use strict';

let _mod = null;

/**
 * @returns {Promise<{runChat: Function} & typeof import('./sse.mjs')>}
 */
function load() {
  if (!_mod) {
    _mod = Promise.all([import('./chat.mjs'), import('./sse.mjs')])
      .then(([chat, sse]) => ({ ...sse, runChat: chat.runChat, buildModel: chat.buildModel }))
      .catch((e) => {
        // 别缓存失败的结果，否则用户装好依赖还得重启进程
        _mod = null;
        throw new Error(`AI 模块加载失败（依赖装了吗？见 deploy/install-deps.sh）：${e.message}`);
      });
  }
  return _mod;
}

module.exports = { load };
