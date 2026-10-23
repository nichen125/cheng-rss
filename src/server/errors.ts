// 统一错误类型与响应体（PLAN §18）。
//
// 错误体固定为 { error: { code, message, retryable } }，
// 前端与 MCP 客户端都按这个形状解析。

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? statusFor(code);
    this.retryable = opts.retryable ?? (code === 'UPSTREAM_ERROR' || code === 'RATE_LIMITED');
  }
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED': return 401;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'BAD_REQUEST': return 400;
    case 'CONFLICT': return 409;
    case 'RATE_LIMITED': return 429;
    case 'BUDGET_EXCEEDED': return 402;
    case 'UPSTREAM_ERROR': return 502;
    case 'INTERNAL': return 500;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean };
}

export function toErrorBody(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof AppError) {
    return {
      status: e.status,
      body: { error: { code: e.code, message: e.message, retryable: e.retryable } },
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: msg, retryable: false } },
  };
}

// 常用构造器
export const badRequest = (m: string) => new AppError('BAD_REQUEST', m);
export const unauthorized = (m = '未登录') => new AppError('UNAUTHORIZED', m);
export const notFound = (m = '不存在') => new AppError('NOT_FOUND', m);
export const conflict = (m: string) => new AppError('CONFLICT', m);
