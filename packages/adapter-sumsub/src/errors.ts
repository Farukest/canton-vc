/**
 * Adapter-local error class. Bubble up to caller-side handling.
 *
 * @module
 */

export type SumsubAdapterErrorCode =
  | 'invalid_config'
  | 'http_error'
  | 'invalid_response'
  | 'invalid_signature'
  | 'missing_signature_header'
  | 'applicant_not_found'
  | 'unauthorized'
  | 'unexpected';

export class SumsubAdapterError extends Error {
  override readonly name = 'SumsubAdapterError';
  readonly code: SumsubAdapterErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: SumsubAdapterErrorCode,
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

export function isSumsubAdapterError(value: unknown): value is SumsubAdapterError {
  return value instanceof SumsubAdapterError;
}
