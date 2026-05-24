/**
 * Tests for the Canton client error taxonomy.
 *
 * `CantonError` is the single failure surface of the Canton layer:
 * every helper in this package throws it, and the route layer
 * branches on `err.code` to translate into the OpenAPI error body
 * shape. These tests pin:
 *
 *   * `name` is stable (`'CantonError'`) across module boundaries.
 *   * Every code in the `CantonErrorCode` union constructs cleanly —
 *     no code is silently dropped when it is eventually added.
 *   * `cause` is preserved when provided (ES2022 semantics) and
 *     absent when omitted.
 *   * `context` is preserved when provided and omitted otherwise.
 *   * `wrap` is idempotent: passing a `CantonError` returns the
 *     original so the first helper in the chain wins.
 *   * `isCantonError` narrows correctly.
 *   * `isCantonErrorWithCode` narrows to the requested code subset.
 */

import { describe, expect, it } from 'vitest';

import type { CantonErrorCode } from '../src';
import { CantonError, isCantonError, isCantonErrorWithCode } from '../src';

/**
 * Exhaustive snapshot of every `CantonErrorCode` the module currently
 * supports. Kept as a readonly tuple so a new code added to the union
 * without being listed here fails compilation (exhaustiveness
 * assertion via `ExhaustiveGuard` below).
 */
const ALL_CODES = [
  'invalid_config',
  'invalid_url',
  'invalid_party',
  'party_not_found',
  'namespace_resolution_failed',
  'party_allocation_failed',
  'invalid_package_name',
  'invalid_contract_id',
  'invalid_command_id',
  'invalid_command',
  'command_validation_failed',
  'request_timeout',
  'network_error',
  'http_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'service_unavailable',
  'invalid_response',
  'empty_response',
  'submit_failed',
  'contract_not_found',
  'contract_archived',
  'ledger_error',
  'command_already_submitted',
  'disclosure_blob_missing',
  'package_id_unresolved',
  'invalid_proof_schema',
  'invalid_proof_input',
  'unexpected',
] as const satisfies readonly CantonErrorCode[];

/**
 * Static exhaustiveness check — if the union grows, this line fails
 * to compile until `ALL_CODES` is updated.
 */
type _AssertExhaustive =
  Exclude<CantonErrorCode, (typeof ALL_CODES)[number]> extends never ? true : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

describe('CantonError', () => {
  it('sets the name to CantonError', () => {
    const err = new CantonError('invalid_config', 'bad');
    expect(err.name).toBe('CantonError');
  });

  it('assigns the code verbatim', () => {
    const err = new CantonError('submit_failed', 'command rejected');
    expect(err.code).toBe('submit_failed');
  });

  it('preserves the original message', () => {
    const err = new CantonError('invalid_party', 'party id missing separator');
    expect(err.message).toBe('party id missing separator');
  });

  it('is an instance of Error and CantonError', () => {
    const err = new CantonError('invalid_response', 'body failed zod');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CantonError);
  });

  it('has a readable stack trace that names CantonError', () => {
    const err = new CantonError('network_error', 'fetch failed');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('CantonError');
  });

  it('preserves the cause when provided (ES2022 Error.cause)', () => {
    const inner = new Error('socket hang up');
    const err = new CantonError('network_error', 'transport failed', { cause: inner });
    expect((err as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('does not set cause when omitted', () => {
    const err = new CantonError('empty_response', '2xx empty body');
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('preserves context when provided', () => {
    const err = new CantonError('http_error', 'upstream 418', {
      context: { status: 418, path: '/v2/state/ledger-end' },
    });
    expect(err.context).toEqual({ status: 418, path: '/v2/state/ledger-end' });
  });

  it('omits context when not provided', () => {
    const err = new CantonError('unauthorized', 'token rejected');
    expect(err.context).toBeUndefined();
  });

  it('accepts arbitrary non-Error causes without coercion', () => {
    const cause = { statusCode: 503, body: 'unavailable' };
    const err = new CantonError('service_unavailable', '5xx', { cause });
    expect((err as unknown as { cause: unknown }).cause).toBe(cause);
  });

  it('constructs every code in the CantonErrorCode union', () => {
    for (const code of ALL_CODES) {
      const err = new CantonError(code, `message for ${code}`);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`message for ${code}`);
      expect(err.name).toBe('CantonError');
    }
  });

  it('keeps instanceof working after throw/catch', () => {
    let caught: unknown;
    try {
      throw new CantonError('contract_not_found', 'no active credential for user');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CantonError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as CantonError).code).toBe('contract_not_found');
  });
});

describe('CantonError.wrap', () => {
  it('wraps an arbitrary Error into a CantonError with the given code', () => {
    const inner = new Error('DNS lookup failed');
    const wrapped = CantonError.wrap('network_error', 'failed to reach participant', inner);
    expect(wrapped).toBeInstanceOf(CantonError);
    expect(wrapped.code).toBe('network_error');
    expect(wrapped.message).toBe('failed to reach participant');
    expect((wrapped as unknown as { cause: Error }).cause).toBe(inner);
  });

  it('wraps non-Error primitive values', () => {
    const wrapped = CantonError.wrap('unexpected', 'bad', 'string cause');
    expect((wrapped as unknown as { cause: unknown }).cause).toBe('string cause');
  });

  it('wraps null and undefined as cause without throwing', () => {
    const wrappedNull = CantonError.wrap('unexpected', 'a', null);
    const wrappedUndefined = CantonError.wrap('unexpected', 'b', undefined);
    expect(wrappedNull).toBeInstanceOf(CantonError);
    expect(wrappedUndefined).toBeInstanceOf(CantonError);
  });

  it('threads context through on wrap', () => {
    const inner = new Error('boom');
    const wrapped = CantonError.wrap('submit_failed', 'daml rejected', inner, {
      commandId: 'crv-create-1',
    });
    expect(wrapped.context).toEqual({ commandId: 'crv-create-1' });
  });

  it('omits context when not passed', () => {
    const wrapped = CantonError.wrap('unexpected', 'boom', new Error('x'));
    expect(wrapped.context).toBeUndefined();
  });

  it('is idempotent — wrapping a CantonError returns the original', () => {
    const original = new CantonError('contract_not_found', 'original');
    const wrapped = CantonError.wrap('unexpected', 'secondary', original);
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe('contract_not_found');
    expect(wrapped.message).toBe('original');
  });

  it('is idempotent even when context is passed alongside a CantonError cause', () => {
    const original = new CantonError('invalid_party', 'bad party');
    const wrapped = CantonError.wrap('unexpected', 'outer', original, { extra: 1 });
    expect(wrapped).toBe(original);
    // The original context is preserved, and we never merge the new context in.
    expect(wrapped.context).toBeUndefined();
  });

  it('uses the supplied code for plain Error causes, not the cause.name', () => {
    class CustomError extends Error {
      override readonly name = 'CustomError';
    }
    const inner = new CustomError('weird');
    const wrapped = CantonError.wrap('invalid_response', 'downstream', inner);
    expect(wrapped.code).toBe('invalid_response');
    expect((wrapped as unknown as { cause: Error }).cause).toBe(inner);
  });
});

describe('isCantonError', () => {
  it('returns true for CantonError instances', () => {
    expect(isCantonError(new CantonError('invalid_config', 'bad'))).toBe(true);
  });

  it('returns false for plain Error instances', () => {
    expect(isCantonError(new Error('plain'))).toBe(false);
  });

  it('returns false for error-shaped plain objects', () => {
    expect(isCantonError({ name: 'CantonError', code: 'invalid_config', message: 'x' })).toBe(
      false,
    );
  });

  it('returns false for non-error primitives', () => {
    expect(isCantonError(undefined)).toBe(false);
    expect(isCantonError(null)).toBe(false);
    expect(isCantonError('CantonError')).toBe(false);
    expect(isCantonError(42)).toBe(false);
    expect(isCantonError([])).toBe(false);
  });
});

describe('isCantonErrorWithCode', () => {
  it('narrows to the requested code when it matches', () => {
    const err: unknown = new CantonError('not_found', 'missing');
    if (isCantonErrorWithCode(err, 'not_found')) {
      // Type-level narrowing: err is CantonError & { code: 'not_found' }
      expect(err.code).toBe('not_found');
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });

  it('returns true when any of several codes match', () => {
    const err = new CantonError('forbidden', 'denied');
    expect(isCantonErrorWithCode(err, 'not_found', 'forbidden')).toBe(true);
  });

  it('returns false when no codes match', () => {
    const err = new CantonError('forbidden', 'denied');
    expect(isCantonErrorWithCode(err, 'not_found', 'unauthorized')).toBe(false);
  });

  it('returns false for plain Error instances', () => {
    expect(isCantonErrorWithCode(new Error('plain'), 'not_found')).toBe(false);
  });

  it('returns false for error-shaped plain objects', () => {
    expect(isCantonErrorWithCode({ name: 'CantonError', code: 'not_found' }, 'not_found')).toBe(
      false,
    );
  });

  it('returns false for non-error values', () => {
    expect(isCantonErrorWithCode(null, 'not_found')).toBe(false);
    expect(isCantonErrorWithCode(undefined, 'not_found')).toBe(false);
    expect(isCantonErrorWithCode('not_found', 'not_found')).toBe(false);
  });

  it('returns false when called with zero code arguments', () => {
    const err = new CantonError('invalid_response', 'x');
    expect(isCantonErrorWithCode(err)).toBe(false);
  });
});
