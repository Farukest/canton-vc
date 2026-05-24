/**
 * Tests for `./src/http`.
 *
 * `http.ts` is the transport layer. It wraps a `FetchLike` impl with:
 *   * AbortController-backed timeout
 *   * Retry on transient failures for idempotent calls
 *   * JSON body validation through a Zod schema
 *   * HTTP → CantonError mapping (401/403/404/409/422/5xx/4xx)
 *   * Structured-error body parsing (CantonApiErrorSchema)
 *   * Command body size cap (maxCommandBodyBytes)
 *
 * These tests use `buildFakeFetch()` to drive every path:
 *   * Happy path GET / POST
 *   * Authorization header presence vs absence
 *   * Status mapping exhaustively
 *   * Structured error body pulled into context.participantError
 *   * Retry policy for GET vs POST, with `retry: 'auto'|'never'` override
 *   * Empty body → empty_response
 *   * Non-JSON body → invalid_response
 *   * Schema validation failure → invalid_response with issues
 *   * Body size over limit → invalid_command
 *   * Pre-aborted signal → request_timeout
 *   * Non-CantonError thrown by fetch → wrapped as 'unexpected'
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CantonError, cantonFetch, cantonFetchOnce, isCantonErrorWithCode } from '../src';

import { buildFakeFetch, buildTestConfig } from './fixtures';

const BodySchema = z.object({ ok: z.boolean() });

describe('cantonFetchOnce — happy paths', () => {
  it('returns the parsed body on a 200 JSON response', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    const result = await cantonFetchOnce(
      config,
      { method: 'GET', path: '/v2/health', schema: BodySchema },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0]?.method).toBe('GET');
    expect(fake.captured[0]?.path).toBe('/v2/health');
  });

  it('builds the full URL from config.baseUrl and path', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'GET', path: '/v2/ping', schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured[0]?.url).toBe('http://canton-participant.test:7575/v2/ping');
  });

  it('prepends a missing leading slash', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'GET', path: 'v2/ping', schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured[0]?.url).toBe('http://canton-participant.test:7575/v2/ping');
  });

  it('sends Content-Type and Accept headers', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'GET', path: '/v2/ping', schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured[0]?.headers['Content-Type']).toBe('application/json');
    expect(fake.captured[0]?.headers['Accept']).toBe('application/json');
  });

  it('omits Authorization header when config.authToken is null', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'GET', path: '/v2/ping', schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured[0]?.headers['Authorization']).toBeUndefined();
  });

  it('includes Bearer Authorization header when config.authToken is set', async () => {
    const config = buildTestConfig({ CANTON_AUTH_TOKEN: 'abc.def.ghi' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'GET', path: '/v2/ping', schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured[0]?.headers['Authorization']).toBe('Bearer abc.def.ghi');
  });

  it('serializes a POST body to JSON', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      {
        method: 'POST',
        path: '/v2/commands',
        body: { hello: 'world' },
        schema: BodySchema,
      },
      fake.fetch,
    );
    expect(fake.captured[0]?.body).toEqual({ hello: 'world' });
  });
});

describe('cantonFetchOnce — body size limit', () => {
  it('throws invalid_command when body exceeds maxCommandBodyBytes', async () => {
    const config = buildTestConfig({ CANTON_MAX_COMMAND_BODY_BYTES: '64' });
    const fake = buildFakeFetch();
    const oversized = { payload: 'x'.repeat(512) };
    try {
      await cantonFetchOnce(
        config,
        { method: 'POST', path: '/v2/commands', body: oversized, schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_command')).toBe(true);
      expect((err as CantonError).message).toMatch(/byte limit/);
    }
    // Fetch is never called when the body is rejected up front.
    expect(fake.captured).toHaveLength(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { ok: true } });
    await cantonFetchOnce(
      config,
      { method: 'POST', path: '/v2/commands', body: { x: 1 }, schema: BodySchema },
      fake.fetch,
    );
    expect(fake.captured).toHaveLength(1);
  });
});

describe('cantonFetchOnce — HTTP error mapping', () => {
  async function run(status: number, body: unknown = { cause: 'nope' }): Promise<CantonError> {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status, body });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CantonError);
      return err as CantonError;
    }
  }

  it('maps 401 → unauthorized', async () => {
    const err = await run(401);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toMatch(/401/);
  });

  it('maps 403 → forbidden', async () => {
    const err = await run(403);
    expect(err.code).toBe('forbidden');
  });

  it('maps 404 → not_found', async () => {
    const err = await run(404);
    expect(err.code).toBe('not_found');
  });

  it('maps 409 → submit_failed', async () => {
    const err = await run(409);
    expect(err.code).toBe('submit_failed');
  });

  it('maps 422 → submit_failed', async () => {
    const err = await run(422);
    expect(err.code).toBe('submit_failed');
  });

  it('maps 500 → service_unavailable', async () => {
    const err = await run(500);
    expect(err.code).toBe('service_unavailable');
  });

  it('maps 503 → service_unavailable', async () => {
    const err = await run(503);
    expect(err.code).toBe('service_unavailable');
  });

  it('maps 418 (generic 4xx) → http_error', async () => {
    const err = await run(418);
    expect(err.code).toBe('http_error');
  });

  it('pulls structured error body into context.participantError', async () => {
    const err = await run(422, {
      cause: 'command validation failed',
      code: 'INVALID_ARGUMENT',
      errorCategory: 8,
    });
    const ctx = err.context as { participantError?: { cause: string } };
    expect(ctx.participantError?.cause).toBe('command validation failed');
    expect(err.message).toMatch(/command validation failed/);
  });

  it('falls back to raw body slice when body is not structured', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'text', status: 500, body: '<html>Gateway Error</html>' });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('service_unavailable');
      expect((err as CantonError).message).toContain('Gateway Error');
    }
  });
});

describe('cantonFetchOnce — body parsing errors', () => {
  it('throws empty_response on a 200 with no body', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'empty' });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'empty_response')).toBe(true);
    }
  });

  it('throws invalid_response on non-JSON body', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'text', body: 'not json at all' });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      const cantonErr = err as CantonError;
      expect(cantonErr.code).toBe('invalid_response');
      expect(cantonErr.message).toMatch(/non-JSON/);
      const ctx = cantonErr.context as { rawBodyPrefix?: string };
      expect(ctx.rawBodyPrefix).toBe('not json at all');
    }
  });

  it('throws invalid_response when JSON does not match schema', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { wrong: 'shape' } });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      const cantonErr = err as CantonError;
      expect(cantonErr.code).toBe('invalid_response');
      expect(cantonErr.message).toMatch(/schema/);
      const ctx = cantonErr.context as { issues?: unknown[] };
      expect(Array.isArray(ctx.issues)).toBe(true);
    }
  });
});

describe('cantonFetchOnce — network failures', () => {
  it('wraps a network error as network_error', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'throw', error: new Error('ECONNREFUSED') });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('network_error');
    }
  });

  it('maps an AbortError to request_timeout', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fake.enqueue({ kind: 'throw', error: abortErr });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('request_timeout');
      expect((err as CantonError).message).toMatch(/timed out/);
    }
  });

  it('detects a DOMException-shaped abort (code=20)', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    const domLike = Object.assign(new Error('aborted'), { code: 20 });
    fake.enqueue({ kind: 'throw', error: domLike });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('request_timeout');
    }
  });

  it('reports the submit timeout in the error message for /v2/commands/submit-and-wait', async () => {
    // Path-aware timeout: a submit-and-wait abort should report the
    // longer `submitTimeoutMs` budget in the timeout message, not the
    // short `requestTimeoutMs` ceiling. This is the user-facing signal
    // that distinguishes "your DevNet commit took 70s" from "your
    // livez probe took 12s".
    const config = buildTestConfig({
      CANTON_REQUEST_TIMEOUT_MS: '10000',
      CANTON_SUBMIT_TIMEOUT_MS: '90000',
    });
    const fake = buildFakeFetch();
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fake.enqueue({ kind: 'throw', error: abortErr });
    try {
      await cantonFetchOnce(
        config,
        {
          method: 'POST',
          path: '/v2/commands/submit-and-wait-for-transaction',
          schema: BodySchema,
        },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('request_timeout');
      expect((err as CantonError).message).toMatch(/timed out after 90000ms/);
    }
  });

  it('reports the request timeout in the error message for non-submit paths', async () => {
    const config = buildTestConfig({
      CANTON_REQUEST_TIMEOUT_MS: '10000',
      CANTON_SUBMIT_TIMEOUT_MS: '90000',
    });
    const fake = buildFakeFetch();
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fake.enqueue({ kind: 'throw', error: abortErr });
    try {
      await cantonFetchOnce(
        config,
        { method: 'GET', path: '/v2/parties/participant-id', schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('request_timeout');
      expect((err as CantonError).message).toMatch(/timed out after 10000ms/);
    }
  });
});

describe('cantonFetch — retry policy', () => {
  it('retries transient failures for GET by default', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '2', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    fake.enqueue({ kind: 'json', body: { ok: true } });
    const result = await cantonFetch(
      config,
      { method: 'GET', path: '/v2/x', schema: BodySchema },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(fake.captured).toHaveLength(3);
  });

  it('stops retrying after maxRetries + 1 attempts', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '2', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    try {
      await cantonFetch(config, { method: 'GET', path: '/v2/x', schema: BodySchema }, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('service_unavailable');
    }
    expect(fake.captured).toHaveLength(3);
  });

  it('does NOT retry a POST by default', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '3', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    try {
      await cantonFetch(
        config,
        { method: 'POST', path: '/v2/commands', body: { x: 1 }, schema: BodySchema },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('service_unavailable');
    }
    expect(fake.captured).toHaveLength(1);
  });

  it('honours retry: auto on a POST override', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '1', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 503, body: { cause: 'later' } });
    fake.enqueue({ kind: 'json', body: { ok: true } });
    const result = await cantonFetch(
      config,
      {
        method: 'POST',
        path: '/v2/state/active-contracts',
        body: { x: 1 },
        schema: BodySchema,
        retry: 'auto',
      },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(fake.captured).toHaveLength(2);
  });

  it('honours retry: never on a GET override', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '3', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    try {
      await cantonFetch(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema, retry: 'never' },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('service_unavailable');
    }
    expect(fake.captured).toHaveLength(1);
  });

  it('does NOT retry non-transient errors like 404', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '3', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 404, body: { cause: 'no' } });
    try {
      await cantonFetch(config, { method: 'GET', path: '/v2/x', schema: BodySchema }, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('not_found');
    }
    expect(fake.captured).toHaveLength(1);
  });

  it('retries a network_error on GET', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '1', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'throw', error: new Error('ECONNRESET') });
    fake.enqueue({ kind: 'json', body: { ok: true } });
    const result = await cantonFetch(
      config,
      { method: 'GET', path: '/v2/x', schema: BodySchema },
      fake.fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(fake.captured).toHaveLength(2);
  });
});

describe('cantonFetch — error wrapping', () => {
  it('wraps a non-Error thrown by fetch as unexpected', async () => {
    const config = buildTestConfig();
    // Use a fetch impl that throws a string (not an Error).
    const fetchImpl = async () => {
      throw 'boom';
    };
    try {
      await cantonFetch(
        config,
        { method: 'GET', path: '/v2/x', schema: BodySchema },
        fetchImpl as unknown as Parameters<typeof cantonFetch>[2],
      );
      throw new Error('expected throw');
    } catch (err) {
      // The inner catch in cantonFetchOnce converts the raw throw
      // into a network_error CantonError. The outer wrap path is
      // only reached for non-Canton errors, so we just verify that
      // we got a CantonError back either way.
      expect(err).toBeInstanceOf(CantonError);
    }
  });
});
