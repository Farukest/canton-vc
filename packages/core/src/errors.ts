/**
 * Error taxonomy for the Canton V2 JSON Ledger client.
 *
 * Every helper in `@/lib/canton` throws `CantonError` (and only
 * `CantonError`) when it fails. The single class deliberately replaces
 * the legacy habit of mixing `throw new Error()` strings with raw
 * boolean returns: callers always receive a structured failure with a
 * machine-readable `.code` that route handlers can translate into the
 * OpenAPI `ApiErrorBody` taxonomy without string-matching the message.
 *
 * The code union is intentionally narrow and concrete. Each code maps
 * to exactly one failure mode. Adding a new code is a documented
 * surface change: test suites assert specific branches, and route
 * handlers in `apps/web/src/app/api/v1/**` branch on `error.code` to
 * pick the right HTTP status + error body.
 *
 * `unexpected` is reserved for programmer errors — a bug we did not
 * anticipate. Network, timeout, response-shape, and participant-side
 * failures all get semantically meaningful codes.
 */

export type CantonErrorCode =
  /* Config + bootstrap */
  | 'invalid_config' // env failed Zod validation (missing secret, bad URL)
  | 'invalid_url' // base URL not a well-formed `http(s)://…`
  /* Party management */
  | 'invalid_party' // party ID string is malformed (no `::`, empty segments)
  | 'party_not_found' // `/v2/parties/<id>` returned 404 or empty partyDetails
  | 'namespace_resolution_failed' // `/v2/parties/participant-id` missing fingerprint
  | 'party_allocation_failed' // `/v2/parties` (allocate) returned without partyDetails
  /* Identifiers */
  | 'invalid_package_name' // template ID string not `#<pkg>:<Module>:<Template>`
  | 'invalid_contract_id' // contract ID empty or obviously malformed
  | 'invalid_command_id' // command ID exceeds bound or malformed
  /* Command construction */
  | 'invalid_command' // command builder rejected an argument (missing field, bad type)
  | 'command_validation_failed' // Zod pre-flight on a serializable command failed
  /* HTTP transport */
  | 'request_timeout' // AbortController timeout fired
  | 'network_error' // fetch threw (DNS, TCP, TLS, DNS resolution, etc.)
  | 'http_error' // non-2xx response outside the structured-error family
  | 'unauthorized' // 401 — participant rejected our credentials
  | 'forbidden' // 403 — participant refused our party authorization
  | 'not_found' // 404 — resource (party, contract) does not exist
  | 'service_unavailable' // 5xx during submit-and-wait
  /* Response validation */
  | 'invalid_response' // body failed Zod validation (shape drift, missing fields)
  | 'empty_response' // participant returned 200 but body was empty JSON
  /* Ledger semantics */
  | 'submit_failed' // submit-and-wait returned a Daml-layer error
  | 'contract_not_found' // ACS query returned empty for a requested credential
  | 'contract_archived' // archived contract cannot be exercised
  | 'ledger_error' // catchall for V2 API completion status != success
  | 'command_already_submitted' // (actAs, commandId) replay inside dedup window — original tx is canonical
  /* Disclosure */
  | 'disclosure_blob_missing' // active contract had no `createdEventBlob`
  | 'package_id_unresolved' // `#name:Module:Template` could not be resolved to a canonical LF hash for DisclosedContract.templateId
  /* Proof hash + schema */
  | 'invalid_proof_schema' // ProofSchemaSpec failed validation (empty vendor, duplicate fields, unsupported canonicalForm)
  | 'invalid_proof_input' // computeProofHash values missing schema-declared fields or contain undeclared keys
  /* Programmer errors */
  | 'unexpected'; // we never promote a driver error silently to this code

/**
 * Canton module error. Subclasses `Error` with a stable `name` so
 * callers can narrow by `err.name === 'CantonError'` and still receive
 * the strong code / cause chain.
 *
 * `cause` is standard ES2022 — we pass the original `fetch`/Zod/
 * participant error through for the observability pipeline. `context`
 * is a free shape keyed to the failing call site so the `pino` child
 * logger can attach it to the error log line (e.g. the contract id,
 * the command id, the HTTP status).
 */
export class CantonError extends Error {
  override readonly name = 'CantonError';
  readonly code: CantonErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: CantonErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      // ES2022: Error.cause
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (options?.context !== undefined) {
      this.context = options.context;
    }
    // Make the error appear correctly under V8 stack traces even when
    // subclassed across modules (Node transpilation quirks).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Wrap an unknown driver/runtime error into a `CantonError` with
   * the given code, preserving the original error as `cause`. If the
   * input is already a `CantonError`, it is returned unchanged so the
   * first helper in the call chain wins (no double-wrapping).
   */
  static wrap(
    code: CantonErrorCode,
    message: string,
    cause: unknown,
    context?: Readonly<Record<string, unknown>>,
  ): CantonError {
    if (cause instanceof CantonError) {
      return cause;
    }
    return new CantonError(code, message, { cause, ...(context ? { context } : {}) });
  }
}

/**
 * Type guard used by the route-layer error mapper. Keeping this in
 * the same module as `CantonError` means a single import covers both.
 */
export function isCantonError(value: unknown): value is CantonError {
  return value instanceof CantonError;
}

/**
 * Narrow by one of a fixed set of codes. Used in tests and in route
 * handlers that only care about e.g. `contract_not_found` vs the rest.
 */
export function isCantonErrorWithCode<C extends CantonErrorCode>(
  value: unknown,
  ...codes: readonly C[]
): value is CantonError & { code: C } {
  return value instanceof CantonError && (codes as readonly string[]).includes(value.code);
}
