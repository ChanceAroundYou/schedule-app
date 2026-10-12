/**
 * error.ts —— API 错误类型
 */

export class ApiError extends Error {
  status: number;
  /** 服务器给的可读原因，用来分辨「时钟不对」这类可重试的情况 */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** 网络层失败（没连上），或者 token 过期 —— 调用方据此决定是否提示重新登录 */
  get offline(): boolean { return this.status === 0; }
}
