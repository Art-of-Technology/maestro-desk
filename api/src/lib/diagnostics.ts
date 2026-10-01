import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

// Diagnostics are an allowlist, not a search-and-replace of arbitrary error text.
// Provider messages, SQL details, URLs and error properties can contain customer data.
const ERROR_TYPES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'URIError', 'ReferenceError',
  'AggregateError', 'AbortError', 'TimeoutError', 'PostgresError', 'PostmarkSendError',
  'PostmarkNotConfiguredError', 'MaestroError', 'HTTPException', 'APIError',
  'BackfillAbortError', 'BackfillBusyError', 'AuthenticationError', 'RateLimitError',
  'APIConnectionError', 'APIConnectionTimeoutError', 'InternalServerError',
]);
const ERROR_CODES = new Set([
  '23505', '23503', '23502', '23514', '22P02', '22001', '42501', '42P01', '42703',
  '40001', '40P01', '53300', '53400', '57014', '57P01', '08006', '08001',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);
export function diagnosticType(value: unknown): string {
  return typeof value === 'string' && ERROR_TYPES.has(value) ? value : 'Error';
}
export function safeError(err: unknown) {
  try {
    const e = err as { code?: unknown; status?: unknown; httpStatus?: unknown } | null;
    const code = e?.code;
    const status = e?.httpStatus ?? e?.status;
    return {
      type: err instanceof Error ? diagnosticType(err.constructor.name) : 'UnknownError',
      code: typeof code === 'string' && ERROR_CODES.has(code) ? code :
        typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999 ? code : null,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    };
  } catch { return { type: 'UnknownError', code: null }; }
}

export function requestDiagnostic(c: Context) {
  // Registered patterns only, including wildcard auth routes. Never fall back to
  // the request URL, even for an unmatched route or an early middleware failure.
  const route = matchedRoutes(c).filter(r => r.method !== 'ALL').at(-1)?.path ?? 'unmatched';
  const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(c.req.method)
    ? c.req.method : 'OTHER';
  return { method, route };
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  console.log('[http]', { ...requestDiagnostic(c), status: c.res.status, durationMs: Math.round(performance.now() - start) });
};
