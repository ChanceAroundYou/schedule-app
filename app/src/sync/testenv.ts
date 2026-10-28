/**
 * testenv.ts —— 同步层单测的公共垫片
 *
 * **只给 `src/sync/*.test.ts` 用**，别被应用代码 import（它装的是假 fetch、假 localStorage）。
 *
 * 为什么要有这一份：`src/sync/` 这一层之前一条单测都没有，而它的难处全在
 * 「要同时有服务器、有本地状态、还要能控制服务器回什么」。六个测试文件各写
 * 一份假服务器，很快就变成「测的是垫片不是引擎」。
 *
 * 垫片只补三样，其余一律用真代码：
 *   localStorage  —— store / token / deviceId 都靠它，Node 里没有
 *   fetch         —— 记下每次请求（URL / 方法 / 请求体），按测试脚本回包
 *   初始 state    —— 一个集、一个 owner，`store.resetLocal()` 之后重灌
 *
 * `node --test` 直接吃 .ts，所以这里不经过 Vite：`import.meta.env` 是 undefined
 * （见 `data/api/request.ts` 里为此加的可选链）。
 */

const mem = new Map<string, string>();

/** Node 里没有 localStorage，装一个内存版（store / token / deviceId 都靠它） */
export function installLocalStorage(): Map<string, string> {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
  return mem;
}

export const CAL = 'cal-1';
export const ME = 'u1';

/**
 * 装上 `navigator.onLine`，返回「恢复原样」的函数。
 *
 * ⚠️ 必须显式装：Node 的全局 `navigator` 只有 `userAgent`，`onLine` 是 undefined。
 * `helpers.ts` 判的是 `onLine === false`（「浏览器明确说离线」），所以
 * **「断网时该说什么」这一档在 Node 里默认永远走不到** —— 不装就等于没测。
 */
export function setOnline(onLine: boolean): () => void {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine }, configurable: true, writable: true,
  });
  return () => {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete (globalThis as Record<string, unknown>).navigator;
  };
}

/** 同步版：装一段、跑完自动恢复（用例之间不许互相影响） */
export function withOnline(onLine: boolean, fn: () => void): void {
  const restore = setOnline(onLine);
  try { fn(); } finally { restore(); }
}

/* 顺序要紧：`installLocalStorage()` 必须早于 store / token 的 import —— 用顶层 await 保证。
   （这两个模块在 import 时都不读 localStorage，但这条规矩一旦破就没人看得出来。） */
installLocalStorage();
const realStore = await import('../data/store.ts');
const { setToken } = await import('../data/api/token.ts');

/** 一个集、我是 owner —— 权限关卡（`commitMany` 会查 `roleOf`）过得去的最小配置 */
export function freshStore(store: typeof realStore = realStore): void {
  mem.clear();
  store.resetLocal();
  store.setCals([{ id: CAL, name: '我的日程', ownerId: ME, createdAt: 0, role: 'owner' }]);
  store.setActiveCal(CAL);
}

/** 一次请求的完整记录（断言「发了什么」全靠它） */
export interface Call {
  url: string;
  method: string;
  /** 请求体（已 JSON.parse）。GET 之类没有正文时是 null */
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/**
 * 测试脚本能表达的三件事：
 *   普通响应      —— 直接给一个对象（SyncResponse 形状即可）
 *   错误响应      —— 带 `__status`（401 / 429…），`req` 会抛 ApiError
 *   请求根本没发出去 —— 带 `__throw`，fetch 抛 TypeError（真·断网）
 */
export interface FakeResponse {
  __status?: number;
  __throw?: string;
  [k: string]: unknown;
}

/**
 * 装一个假 fetch。`handle` 按调用顺序被调用，返回 undefined 时回一个「什么都没发生」的空响应。
 * @returns calls：按顺序记下每一次请求；restore：撤掉假 fetch
 */
export function fakeFetch(
  handle: (c: Call, index: number) => FakeResponse | undefined,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const prev = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = String((init && init.method) || 'GET');
    const rawHeaders = (init && init.headers) || {};
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : null;
    const call: Call = {
      url, method, body,
      headers: rawHeaders as Record<string, string>,
    };
    const index = calls.length;
    calls.push(call);

    const out = handle(call, index) ?? {};
    if (out.__throw) throw new TypeError(out.__throw);

    const status = out.__status ?? 200;
    const payload: Record<string, unknown> = { ...out };
    delete payload.__status;
    delete payload.__throw;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = prev; } };
}

/** 一个「什么都没发生」的同步响应（服务器没收下任何 op、也没有新变更） */
export function idleSync(cursor = 0): FakeResponse {
  return { cursor, applied: [], rejected: [] };
}

/**
 * 装一只 token。`syncNow()` 第一件事就是「没有 token 直接返回」——
 * 不登录的单测会「全绿」地一个请求都不发，那种绿没有意义。
 */
export function signIn(): void { setToken('test-token'); }
export function signOut(): void { setToken(null); }
