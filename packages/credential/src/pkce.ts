/**
 * PKCE helpers (RFC 7636) using `@noble/hashes` for SHA-256 — pure
 * JavaScript, isomorphic, audited. Works identically in modern
 * browsers, Deno, Bun, Node.js, and any serverless runtime without
 * depending on Web Crypto being available.
 *
 * @module
 */

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

import { CantonVcOauthError } from './errors';

/** RFC 7636 §4.1 — verifier is 43-128 chars of the unreserved URI set. */
const VERIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export type CodeChallengeMethod = 'S256';

/**
 * Generate a cryptographically random `code_verifier`. Default 64
 * chars — comfortably in the 43–128 RFC range and long enough that
 * a brute-force attempt is implausible.
 */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new CantonVcOauthError(
      'pkce_invalid',
      `code_verifier length must be 43-128 (got ${length}).`,
    );
  }
  const bytes = new Uint8Array(length);
  const cryptoSource = resolveCrypto();
  cryptoSource.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // `bytes` is a Uint8Array of exactly `length` items, so `bytes[i]`
    // is always defined inside the loop — but TS sees `number | undefined`
    // under `noUncheckedIndexedAccess`. Fall back to 0 to keep the
    // type narrow without changing observable behaviour.
    const byte = bytes[i] ?? 0;
    out += VERIFIER_CHARSET[byte % VERIFIER_CHARSET.length];
  }
  return out;
}

/**
 * Compute the S256 `code_challenge` = base64url(SHA-256(verifier)).
 * Matches the server's `computeCodeChallenge` output byte-for-byte.
 */
export async function computeCodeChallenge(
  verifier: string,
  method: CodeChallengeMethod = 'S256',
): Promise<string> {
  if (method !== 'S256') {
    throw new CantonVcOauthError('pkce_invalid', `Unsupported method: ${method}`);
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await sha256(data);
  return base64UrlEncode(digest);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(data);
}

function resolveCrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto !== null) {
    return globalThis.crypto;
  }
  throw new CantonVcOauthError(
    'pkce_invalid',
    'No Web Crypto implementation found. Upgrade to Node.js ≥18 or run in a modern browser.',
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    // See note in `generateRandomString`: index access is in-bounds
    // by construction; fall back to 0 to satisfy
    // `noUncheckedIndexedAccess` without an assertion.
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a random opaque `state` value suitable for CSRF
 * protection. 32 bytes → 43 base64url chars. Not a secret; it only
 * needs to be unpredictable-enough that an attacker can't forge a
 * matching value in a CSRF flow.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  resolveCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Generate an OIDC `nonce`. Same shape as state; separate function
 * so consumers that want both can keep them distinct.
 */
export function generateNonce(): string {
  return generateState();
}
