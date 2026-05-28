// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assertLooksLikePseudonym,
  looksLikePseudonym,
  MIN_PSEUDONYM_ENTROPY_BITS,
  MIN_PSEUDONYM_LENGTH,
} from '../src/pseudonym-check';

describe('looksLikePseudonym', () => {
  it('accepts a hex-encoded random 32-byte pseudonym', () => {
    expect(
      looksLikePseudonym(
        'a7f4c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036',
      ),
    ).toBe(true);
  });

  it('accepts a base64-encoded random pseudonym', () => {
    expect(looksLikePseudonym('Kp9LqM3eFvR8sT2aWxYn4uZ6cE5dG7hJ')).toBe(true);
  });

  it('accepts a UUID v4 with the cred_ prefix recommended by issuer-side helpers', () => {
    expect(looksLikePseudonym('cred_3f8a9d2e-7b4c-4e6a-9d1f-5c8b2a4e6f9d')).toBe(true);
  });

  it('rejects an empty value', () => {
    expect(looksLikePseudonym('')).toBe(false);
  });

  it(`rejects a value shorter than ${MIN_PSEUDONYM_LENGTH} characters`, () => {
    expect(looksLikePseudonym('a'.repeat(MIN_PSEUDONYM_LENGTH - 1))).toBe(false);
  });

  it('rejects an email address', () => {
    expect(looksLikePseudonym('alice.smith@example.com')).toBe(false);
  });

  it('rejects a user_-prefixed identifier', () => {
    expect(looksLikePseudonym('user_a8f7c91b2e8d5036a4f7c91b2e')).toBe(false);
  });

  it('rejects a customer_-prefixed identifier', () => {
    expect(looksLikePseudonym('customer_a8f7c91b2e8d5036a4f7c91b2e')).toBe(false);
  });

  it('rejects a value with whitespace', () => {
    expect(looksLikePseudonym('a8f7c91b 2e8d5036a4f7c91b2e8d5036a4')).toBe(false);
  });

  it('rejects a low-entropy repeated-character string at the length threshold', () => {
    expect(looksLikePseudonym('aaaaaaaaaaaaaaaaaaaaaaaaaaaabb')).toBe(false);
  });

  it('rejects a single-character padding identifier', () => {
    expect(looksLikePseudonym('x'.repeat(40))).toBe(false);
  });

  it('rejects undefined', () => {
    expect(looksLikePseudonym(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(looksLikePseudonym(null)).toBe(false);
  });

  it('passes the entropy floor for the canonical reference values', () => {
    expect(MIN_PSEUDONYM_ENTROPY_BITS).toBeLessThan(4.0);
    expect(MIN_PSEUDONYM_ENTROPY_BITS).toBeGreaterThan(0);
  });
});

describe('assertLooksLikePseudonym', () => {
  it('returns undefined for a valid pseudonym', () => {
    expect(() =>
      assertLooksLikePseudonym(
        'a7f4c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036a4f7c91b2e8d5036',
      ),
    ).not.toThrow();
  });

  it('throws on an email value', () => {
    expect(() => assertLooksLikePseudonym('alice.smith@example.com')).toThrowError(
      /failed the pseudonym heuristic/,
    );
  });

  it('throws on a user_-prefixed identifier', () => {
    expect(() => assertLooksLikePseudonym('user_a8f7c91b2e8d5036a4f7c91b2e')).toThrowError(
      /pseudonym heuristic/,
    );
  });

  it('throws on an empty value', () => {
    expect(() => assertLooksLikePseudonym('')).toThrowError(/pseudonym heuristic/);
  });

  it('includes the original value in the error message', () => {
    expect(() => assertLooksLikePseudonym('customer_99')).toThrowError(/"customer_99"/);
  });
});
