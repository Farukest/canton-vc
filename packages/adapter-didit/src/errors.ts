/**
 * Adapter-local error class. Bubble up to caller-side handling.
 *
 * @module
 */

export type DiditAdapterErrorCode =
  | 'invalid_config'
  | 'http_error'
  | 'invalid_response'
  | 'invalid_signature'
  | 'stale_signature'
  | 'missing_signature_header'
  | 'session_not_found'
  | 'unauthorized'
  | 'unexpected';

export class DiditAdapterError extends Error {
  override readonly name = 'DiditAdapterError';
  readonly code: DiditAdapterErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: DiditAdapterErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (options?.context !== undefined) {
      this.context = options.context;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDiditAdapterError(value: unknown): value is DiditAdapterError {
  return value instanceof DiditAdapterError;
}
