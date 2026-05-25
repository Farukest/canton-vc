// @vitest-environment node

import type { CredentialView } from '@canton-vc/core';
import { describe, expect, it } from 'vitest';
import {
  assertUserRefIsPseudonym,
  MIN_PSEUDONYM_ENTROPY_BITS,
  MIN_PSEUDONYM_LENGTH,
  userRefLooksLikePseudonym,
} from '../src/pseudonym-check';

function viewWith(userRef: string): CredentialView {
  return {
    userRef,
    proofHash: 'f64293282671f911d9adf6caf9320f3946abd5f51d269b49285a318f0d8871b8',
    status: 'Active',
    level: 'Enhanced',
    validUntil: '2027-05-10T22:37:24Z',
    network: 'Canton Mainnet',
    humanScore: 95,
    validator: 'DiditValidator',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: true,
    isActive: true,
    proofSchemaId: 'cafebabe1234567890abcdef',
  };
}

describe('userRefLooksLikePseudonym', () => {
  it('accepts a hex-encoded random 32-byte pseudonym', () => {
    // 64 hex chars, uniform distribution → ~4.0 bits/char, well above cutoff.
    const view = viewWith(
      'a7f4c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036',
    );
    expect(userRefLooksLikePseudonym(view)).toBe(true);
  });

  it('accepts a base64-encoded random pseudonym', () => {
    // 32 base64 chars, ~5.5 bits/char.
    const view = viewWith('Kp9LqM3eFvR8sT2aWxYn4uZ6cE5dG7hJ');
    expect(userRefLooksLikePseudonym(view)).toBe(true);
  });

  it('accepts a UUID v4 with the cred_ prefix recommended by issuer-side helpers', () => {
    // 37 chars total. The `cred_` prefix is a credential-scope marker, NOT a
    // customer-stable identifier hint — only the customer-pointing prefixes
    // (`user_`, `customer_`, `acct_`, etc.) trip the stable-identifier guard.
    const view = viewWith('cred_3f8a9d2e-7b4c-4e6a-9d1f-5c8b2a4e6f9d');
    expect(userRefLooksLikePseudonym(view)).toBe(true);
  });

  it('rejects an empty userRef', () => {
    const view = viewWith('');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it(`rejects a userRef shorter than ${MIN_PSEUDONYM_LENGTH} characters`, () => {
    const view = viewWith('a'.repeat(MIN_PSEUDONYM_LENGTH - 1));
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects an email address as userRef', () => {
    const view = viewWith('alice.smith@example.com');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects a user_-prefixed identifier', () => {
    const view = viewWith('user_a8f7c91b2e8d5036a4f7c91b2e');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects a customer_-prefixed identifier', () => {
    const view = viewWith('customer_a8f7c91b2e8d5036a4f7c91b2e');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects a userRef with whitespace', () => {
    const view = viewWith('a8f7c91b 2e8d5036a4f7c91b2e8d5036a4');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects a low-entropy repeated-character string at the length threshold', () => {
    // 30 chars of just `a` and `b` → entropy ~1 bit/char, well below the
    // 3.0-bit cutoff.
    const view = viewWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaabb');
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('rejects a single-character padding identifier', () => {
    const view = viewWith('x'.repeat(40));
    expect(userRefLooksLikePseudonym(view)).toBe(false);
  });

  it('passes the entropy floor for the canonical reference values', () => {
    // Sanity check: the documented cutoff is below hex (4.0) and base64
    // (~5.9), so both reference encodings clear the bar with margin.
    expect(MIN_PSEUDONYM_ENTROPY_BITS).toBeLessThan(4.0);
    expect(MIN_PSEUDONYM_ENTROPY_BITS).toBeGreaterThan(0);
  });
});

describe('assertUserRefIsPseudonym', () => {
  it('returns undefined for a valid pseudonym', () => {
    const view = viewWith(
      'a7f4c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036',
    );
    expect(() => assertUserRefIsPseudonym(view)).not.toThrow();
  });

  it('throws on an email userRef', () => {
    const view = viewWith('alice.smith@example.com');
    expect(() => assertUserRefIsPseudonym(view)).toThrowError(
      /failed the pseudonym heuristic/,
    );
  });

  it('throws on a user_-prefixed identifier', () => {
    const view = viewWith('user_a8f7c91b2e8d5036a4f7c91b2e');
    expect(() => assertUserRefIsPseudonym(view)).toThrowError(
      /pseudonym heuristic/,
    );
  });

  it('throws on an empty userRef', () => {
    const view = viewWith('');
    expect(() => assertUserRefIsPseudonym(view)).toThrowError(
      /pseudonym heuristic/,
    );
  });

  it('throws with the original userRef included in the message', () => {
    const view = viewWith('customer_99');
    expect(() => assertUserRefIsPseudonym(view)).toThrowError(
      /"customer_99"/,
    );
  });
});
