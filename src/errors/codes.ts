/** Typed application / upstream error codes returned to MCP clients. */
export const ErrorCodes = {
  INVALID_INPUT: "INVALID_INPUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  SHOPEE_AUTH_EXPIRED: "SHOPEE_AUTH_EXPIRED",
  SHOPEE_RATE_LIMITED: "SHOPEE_RATE_LIMITED",
  SHOPEE_RESPONSE_INVALID: "SHOPEE_RESPONSE_INVALID",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
  MUTATION_DISABLED: "MUTATION_DISABLED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  RESULT_LIMIT_EXCEEDED: "RESULT_LIMIT_EXCEEDED",
  HOST_NOT_ALLOWED: "HOST_NOT_ALLOWED",
  REDIRECT_NOT_ALLOWED: "REDIRECT_NOT_ALLOWED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { status?: number; details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? statusFor(code);
    this.details = options?.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

const KNOWN_CODES = new Set<string>(Object.values(ErrorCodes));

/**
 * True for AppError instances and for AppErrors that crossed a Durable Object
 * / RPC boundary, which arrive as plain Error with name and code copied over.
 */
export function isAppErrorLike(
  err: unknown,
): err is { name: "AppError"; code: string; message: string; status?: number } {
  if (err instanceof AppError) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AppError" && typeof e.code === "string";
}

/** Rehydrate an AppError-like value; unknown codes become UPSTREAM_ERROR. */
export function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (!isAppErrorLike(err)) return undefined;
  const code = KNOWN_CODES.has(err.code)
    ? (err.code as ErrorCode)
    : ErrorCodes.UPSTREAM_ERROR;
  const message = typeof err.message === "string" ? err.message : code;
  return new AppError(code, message, {
    ...(typeof err.status === "number" ? { status: err.status } : {}),
  });
}

function statusFor(code: ErrorCode): number {
  switch (code) {
    case ErrorCodes.INVALID_INPUT:
      return 400;
    case ErrorCodes.UNAUTHORIZED:
    case ErrorCodes.SHOPEE_AUTH_EXPIRED:
      return 401;
    case ErrorCodes.FORBIDDEN:
    case ErrorCodes.MUTATION_DISABLED:
      return 403;
    case ErrorCodes.UNSUPPORTED_OPERATION:
      return 404;
    case ErrorCodes.APPROVAL_REQUIRED:
      return 409;
    case ErrorCodes.SHOPEE_RATE_LIMITED:
      return 429;
    case ErrorCodes.RESULT_LIMIT_EXCEEDED:
      return 413;
    case ErrorCodes.UPSTREAM_TIMEOUT:
      return 504;
    default:
      return 502;
  }
}
