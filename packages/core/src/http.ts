/**
 * Low-level HTTP client for the Canton V2 JSON Ledger API.
 *
 * This layer is deliberately thin: it takes a `CantonConfig`, a path,
 * a method, an optional body, and an output Zod schema; it returns a
 * parsed, validated value. It does not know about parties, contracts,
 * or commands — that's what `commands.ts`, `ledger.ts`, and `query.ts`
 * are for. The separation keeps the HTTP layer unit-testable with a
 * fake `fetch` and keeps the semantic layers independent of Node's
 * runtime behavior.
 *
 * Responsibilities:
 *
 *   * **Timeout** — every call is wrapped in an `AbortController`
 *     keyed to `CantonConfig.requestTimeoutMs`. On timeout we throw
 *     `CantonError('request_timeout', …)`.
 *
 *   * **Retry** — idempotent reads (GET and a handful of read-only
 *     POSTs marked `idempotent: true`) are retried on network and 5xx
 *     failures with exponential backoff. Writes (create/verify/revoke)
 *     are never retried automatically — retry safety is the caller's
 *     problem, since Daml commands carry a `commandId` that the
 *     participant deduplicates within a window.
 *
 *   * **Auth** — if `CantonConfig.authToken` is set, we attach it as
 *     `Authorization: Bearer …`. On MainNet the token is null and the
 *     header is omitted.
 *
 *   * **Response validation** — every 2xx body is parsed through the
 *     provided Zod schema. Shape drift surfaces as
 *     `CantonError('invalid_response', …)` with the Zod issue list in
 *     `cause`.
 *
 *   * **Error mapping** — 4xx and 5xx responses try to parse the body
 *     with `CantonApiErrorSchema` (Canton's structured error shape)
 *     and map to the appropriate `CantonErrorCode`. Unstructured
 *     error bodies fall back to `http_error`.
 *
 * The `fetch` implementation is injected via an optional `fetchImpl`
 * parameter so tests can provide a deterministic stub; production
 * uses the Node 22 built-in `globalThis.fetch`.
 */

import type { z } from 'zod';

import type { CantonConfig } from './config';
import { CantonError } from './errors';
import { type CantonApiError, CantonApiErrorSchema } from './schemas';

/* ---------- Types ---------- */

/**
 * A minimal subset of the Web Fetch API we depend on. Declaring the
 * shape explicitly (instead of importing `typeof fetch`) lets tests
 * provide a pure JS implementation that doesn't need to live in the
 * DOM lib.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  text(): Promise<string>;
}

/**
 * Arguments accepted by `cantonFetch`. The generic parameter `T` is
 * the shape the caller expects back; it is inferred from `schema`.
 */
export interface CantonFetchOptions<T> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /**
   * Retry policy. `auto` retries GETs and explicitly-marked POSTs.
   * Writes default to `never`. Callers can override for rare cases
   * where a POST is safe to retry (e.g. ACS queries, ledger-end).
   */
  readonly retry?: 'auto' | 'never';
  /**
   * Extra context attached to error reports — propagated to the
   * observability pipeline via `CantonError.context`.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

/* ---------- Helpers ---------- */

/**
 * Build the `Authorization` header iff a token is set. MainNet runs
 * with auth disabled, so this is usually empty.
 */
function buildHeaders(config: CantonConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.authToken !== null) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }
  return headers;
}

/**
 * Join the config base URL and a path, tolerating leading/trailing
 * slashes. The config loader already strips the trailing slash from
 * the base URL, but we keep the `startsWith('/')` guard for paths
 * that callers supply without a leading slash.
 */
function buildUrl(config: CantonConfig, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${config.baseUrl}${normalized}`;
}

/**
 * Encode a request body to a JSON string. Throws `invalid_request`
 * if the body exceeds the configured `maxCommandBodyBytes` bound —
 * this protects the participant from accidentally huge payloads
 * caused by a bug in the command builder.
 */
function encodeBody(config: CantonConfig, body: unknown): string {
  const serialized = JSON.stringify(body);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > config.maxCommandBodyBytes) {
    throw new CantonError(
      'invalid_command',
      `Command body exceeds the configured ${config.maxCommandBodyBytes}-byte limit (was ${byteLength} bytes).`,
      { context: { byteLength, limit: config.maxCommandBodyBytes } },
    );
  }
  return serialized;
}

/**
 * Attempt to parse a response body as the Canton structured error
 * shape. Returns `null` when parsing fails (e.g. HTML error page,
 * empty body). Used to decide between `http_error` (generic) and the
 * more specific codes like `ledger_error` / `submit_failed`.
 */
function tryParseStructuredError(rawBody: string): CantonApiError | null {
  if (rawBody.length === 0) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(rawBody);
    const parsed = CantonApiErrorSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Translate an HTTP failure into the narrowest possible Canton error
 * code. 401 / 403 / 404 get dedicated codes so route handlers can
 * branch; 5xx during writes maps to `submit_failed` when we can pull
 * a structured cause out, otherwise `service_unavailable`.
 */
function mapHttpError(
  status: number,
  rawBody: string,
  context: Readonly<Record<string, unknown>>,
): CantonError {
  const structured = tryParseStructuredError(rawBody);
  const cause = structured?.cause ?? structured?.code ?? rawBody.slice(0, 1024);
  const fullContext = {
    ...context,
    status,
    ...(structured ? { participantError: structured } : {}),
  };

  if (status === 401) {
    return new CantonError(
      'unauthorized',
      `Canton participant rejected our credentials (401): ${cause}`,
      { context: fullContext },
    );
  }
  if (status === 403) {
    return new CantonError('forbidden', `Canton participant refused the request (403): ${cause}`, {
      context: fullContext,
    });
  }
  if (status === 404) {
    return new CantonError('not_found', `Canton resource not found (404): ${cause}`, {
      context: fullContext,
    });
  }
  if (status === 409 || status === 422) {
    // 409 conflict / 422 unprocessable — command validation or Daml
    // interpretation failed. Canton emits structured errors here.
    //
    // Special-case: command deduplication. When the same
    // `(actAs, commandId)` pair is submitted within the participant's
    // dedup window, Canton replies with the Daml `DUPLICATE_COMMAND`
    // error (gRPC ALREADY_EXISTS = code 6). The original transaction
    // remains canonical; chain has exactly one event. We surface this
    // as a distinct code so callers using deterministic command ids
    // (e.g. NFT mint) can recognise the replay and rehydrate from
    // the existing on-chain artefact instead of treating it as a
    // generic submit failure.
    const isDuplicate =
      structured?.code === 'DUPLICATE_COMMAND' || structured?.grpcCodeValue === 6;
    if (isDuplicate) {
      return new CantonError(
        'command_already_submitted',
        `Canton already accepted this command id (dedup): ${cause}`,
        { context: fullContext },
      );
    }
    return new CantonError('submit_failed', `Canton rejected the command (${status}): ${cause}`, {
      context: fullContext,
    });
  }
  if (status >= 500 && status <= 599) {
    return new CantonError(
      'service_unavailable',
      `Canton participant returned ${status}: ${cause}`,
      { context: fullContext },
    );
  }
  return new CantonError('http_error', `Canton participant returned ${status}: ${cause}`, {
    context: fullContext,
  });
}

/**
 * Decide whether a fetch error is transient (retryable) or fatal.
 * Network hiccups and 5xx are transient; structured submit failures
 * (4xx, unauthorized, not_found) are not.
 */
function isTransient(err: CantonError): boolean {
  return (
    err.code === 'network_error' ||
    err.code === 'request_timeout' ||
    err.code === 'service_unavailable'
  );
}

/**
 * Sleep for `ms` milliseconds, wrapped in a promise. Extracted so
 * tests can stub it without faking `setTimeout`.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ---------- Core ---------- */

/**
 * Execute a single (non-retried) HTTP call against the Canton
 * participant. Parses the response through the provided schema.
 *
 * Exposed mainly for tests and for the retry loop. Callers in
 * `ledger.ts` / `query.ts` should use `cantonFetch`.
 */
export async function cantonFetchOnce<T>(
  config: CantonConfig,
  options: CantonFetchOptions<T>,
  fetchImpl: FetchLike,
): Promise<T> {
  const url = buildUrl(config, options.path);
  const headers = buildHeaders(config);
  const body = options.body !== undefined ? encodeBody(config, options.body) : undefined;
  const context: Readonly<Record<string, unknown>> = {
    method: options.method,
    path: options.path,
    ...(options.context ?? {}),
  };

  // Path-aware timeout. Submit-and-wait commits hold the connection
  // open until the participant has confirmed the tx on the
  // synchronizer (5-30s typical on DevNet, occasionally 60s+ under
  // contention). Every other path is a fast probe / query and should
  // fail fast on a real network problem instead of stalling the worker
  // for a minute. The submit prefix matches both
  // `/v2/commands/submit-and-wait` and the streaming
  // `/v2/commands/submit-and-wait-for-transaction*` variants.
  const isSubmitAndWait = options.path.startsWith('/v2/commands/submit-and-wait');
  const effectiveTimeoutMs = isSubmitAndWait
    ? config.submitTimeoutMs
    : config.requestTimeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, effectiveTimeoutMs);

  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      throw new CantonError(
        'request_timeout',
        `Canton request timed out after ${effectiveTimeoutMs}ms: ${options.method} ${options.path}`,
        { cause: err, context },
      );
    }
    throw new CantonError(
      'network_error',
      `Canton request failed with a network error: ${options.method} ${options.path}`,
      { cause: err, context },
    );
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await response.text().catch((readErr: unknown) => {
    throw new CantonError('network_error', 'Failed to read Canton response body.', {
      cause: readErr,
      context,
    });
  });

  if (!response.ok) {
    throw mapHttpError(response.status, rawBody, context);
  }

  if (rawBody.length === 0) {
    throw new CantonError(
      'empty_response',
      `Canton returned an empty 2xx body: ${options.method} ${options.path}`,
      { context },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch (jsonErr) {
    throw new CantonError(
      'invalid_response',
      `Canton returned non-JSON body: ${options.method} ${options.path}`,
      {
        cause: jsonErr,
        context: { ...context, rawBodyPrefix: rawBody.slice(0, 512) },
      },
    );
  }

  const validated = options.schema.safeParse(parsedJson);
  if (!validated.success) {
    throw new CantonError(
      'invalid_response',
      `Canton response failed schema validation: ${options.method} ${options.path}`,
      {
        cause: validated.error,
        context: {
          ...context,
          issues: validated.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  return validated.data;
}

/**
 * Public entry point. Performs the fetch, retries on transient
 * failures for idempotent calls, and returns the validated body.
 */
export async function cantonFetch<T>(
  config: CantonConfig,
  options: CantonFetchOptions<T>,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<T> {
  const retryMode: 'auto' | 'never' =
    options.retry ?? (options.method === 'GET' ? 'auto' : 'never');
  const maxAttempts = retryMode === 'auto' ? config.maxRetries + 1 : 1;

  let lastError: CantonError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await cantonFetchOnce(config, options, fetchImpl);
    } catch (err) {
      if (!(err instanceof CantonError)) {
        // Programmer error — don't retry.
        throw CantonError.wrap(
          'unexpected',
          'Canton fetch raised a non-CantonError.',
          err,
          options.context,
        );
      }
      lastError = err;
      if (retryMode === 'never' || !isTransient(err) || attempt >= maxAttempts) {
        throw err;
      }
      // Exponential backoff: base * 2^(attempt-1). Bounded by a
      // short ceiling since the outer request timeout already caps
      // the total wait.
      const backoff = Math.min(
        config.retryBaseDelayMs * 2 ** (attempt - 1),
        config.requestTimeoutMs,
      );
      await delay(backoff);
    }
  }
  // Unreachable — the loop either returns or throws. Typescript
  // needs the fallback for control-flow narrowing.
  throw (
    lastError ?? new CantonError('unexpected', 'Canton fetch exhausted retries without an error.')
  );
}

/* ---------- Abort detection ---------- */

/**
 * Detect a fetch-level abort. Different fetch implementations surface
 * this differently: Node's undici sets `err.name === 'AbortError'`,
 * while the Web standard uses a `DOMException` with `code === 20`.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 20
  ) {
    return true;
  }
  return false;
}
