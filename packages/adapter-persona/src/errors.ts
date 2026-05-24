/**
 * Adapter-local error class. Bubble up to caller-side handling.
 *
 * @module
 */

export type PersonaAdapterErrorCode =
  | 'invalid_config'
  | 'http_error'
  | 'invalid_response'
  | 'invalid_signature'
  | 'missing_signature_header'
  | 'inquiry_not_found'
  | 'session_url_missing'
  | 'unauthorized'
  | 'unexpected';

export class PersonaAdapterError extends Error {
  override readonly name = 'PersonaAdapterError';
  readonly code: PersonaAdapterErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: PersonaAdapterErrorCode,
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

export function isPersonaAdapterError(value: unknown): value is PersonaAdapterError {
  return value instanceof PersonaAdapterError;
}
