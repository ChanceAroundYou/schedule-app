/**
 * constants.ts —— 同步引擎常量
 */

/** 服务端 MAX_OPS 是 2000，留出余量分批 */
const OPS_PER_CALL = 500;
/** 一轮同步最多几个来回。防的是「推不完就一直推」把界面卡住 */
const MAX_ROUNDS = 8;
/** 本地改动后攒一会儿再推，连续操作只发一次 */
const PUSH_DEBOUNCE_MS = 1200;
/** 兜底轮询：只在 outbox 非空时才真的发请求 */
const POLL_MS = 15000;

export { OPS_PER_CALL, MAX_ROUNDS, PUSH_DEBOUNCE_MS, POLL_MS };
