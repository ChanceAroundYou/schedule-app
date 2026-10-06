/**
 * 构建期常量。
 *
 * `__APP_VERSION__` 由 vite.config.ts 的 `define` 注入，值取 package.json 的
 * version。**源码里不许再写死版本号** —— 那份一定会跟 package.json 漂开，
 * 而设置页「关于」那张卡是用户报问题时唯一会念出来的东西。
 *
 * 声明放这里而不是某个 .ts 里：`define` 是**替换文本**，不是模块导出，
 * 所以对 TS 来说它是一个全局裸变量，得用 declare const 告诉它。
 */
declare const __APP_VERSION__: string;
