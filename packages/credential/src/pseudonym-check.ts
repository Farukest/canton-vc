/**
 * Opt-in verifier-side heuristic that flags suspicious `userRef`
 * values on a verified `CredentialView`.
 *
 * CIP #204 (https://github.com/canton-foundation/cips/pull/204)
 * does not mandate how the issuer-side reference identifier
 * (carried as a claim in the credential's `claims` TextMap under
 * the issuer's reverse-DNS namespace, e.g. `com.example/userRef`)
 * is constructed. This SDK recommends credential-scoped random
 * pseudonyms rather than stable customer-DB identifiers; an issuer
 * that emits the same `userRef` to multiple verifiers exposes the
 * holder to cross-verifier correlation when those verifiers
 * collude or hold side-channel data on the holder.
 *
 * The on-chain template's `ensure` clause only requires
 * `userRef /= ""`, so the standard cannot enforce a particular
 * pseudonym scheme at the protocol layer — neither can the W3C VC
 * family of standards, for the same reason. This helper closes that
 * gap on the verifier side: a privacy-conscious verifier can call
 * `userRefLooksLikePseudonym(view)` after `verifyDisclosure()` and
 * downgrade trust, log a warning, or refuse to honour the credential
 * when the result is `false`.
 *
 * The check is intentionally a heuristic, not a cryptographic proof.
 * A determined issuer can defeat it (e.g. by SHA-256-hashing the
 * customer id and emitting the hex digest), but in practice the
 * common failure modes — emitting raw emails, prefixed IDs like
 * `user_123`, low-entropy autoincrement integers, or readable UUIDs
 * with embedded customer attributes — are exactly what this catches.
 *
 * @module
 */

import type { CredentialView } from '@canton-vc/core';
import { getClaim } from '@canton-vc/core';

/**
 * Minimum acceptable length for a `userRef` that is being claimed as
 * a random pseudonym. 24 chars matches base64-encoded 18 random
 * bytes (well above birthday-bound for any realistic issuer scale);
 * 32 chars matches a hex-encoded 16 random bytes (UUID-equivalent).
 * Anything shorter is implausible as a freshly-minted pseudonym.
 */
export const MIN_PSEUDONYM_LENGTH = 24;

/**
 * Substrings that immediately disqualify a value from being a random
 * pseudonym. Stable-identifier prefixes, email shape, common DB
 * naming conventions. Lowercase-compared.
 */
const STABLE_IDENTIFIER_HINTS: readonly string[] = [
  '@', // any email shape
  'user_',
  'user-',
  'cust_',
  'cust-',
  'customer_',
  'customer-',
  'usr_',
  'usr-',
  'acct_',
  'account_',
  'member_',
  'holder_',
  'subject_',
  'profile_',
] as const;

/**
 * Shannon entropy (bits per character) of a string, treated as a
 * bag of characters. A truly random pseudonym over a 16-symbol
 * alphabet (hex) gives ~4 bits/char; over base64 (~64 symbols) gives
 * ~6 bits/char. Stable identifiers with repeated tokens, prefixes,
 * or natural-language fragments score materially lower because the
 * character distribution skews toward a few common values.
 */
function shannonEntropyPerChar(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Minimum acceptable Shannon entropy per character for a value to
 * pass as a random pseudonym. 3.0 bits/char comfortably accepts hex
 * (4.0 / char), base64 (5.9), and base32, while rejecting prefixed
 * IDs like `customer_12345` (~2.7) and emails (~3.0–3.3 with the
 * domain ballast pulling the score down past the cutoff for short
 * locals).
 */
export const MIN_PSEUDONYM_ENTROPY_BITS = 3.0;

/**
 * Returns `true` when the supplied string plausibly looks like a
 * credential-scoped random pseudonym, and `false` otherwise.
 * Heuristic — see module docstring for the rationale.
 *
 * Reasons a value returns `false`:
 *   - empty or shorter than {@link MIN_PSEUDONYM_LENGTH}
 *   - contains an `@` (email shape) or a stable-identifier prefix
 *   - Shannon entropy below {@link MIN_PSEUDONYM_ENTROPY_BITS}
 *   - contains whitespace (a real pseudonym never does)
 */
export function looksLikePseudonym(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string' || raw.length < MIN_PSEUDONYM_LENGTH) {
    return false;
  }
  if (/\s/.test(raw)) {
    return false;
  }
  const lower = raw.toLowerCase();
  for (const hint of STABLE_IDENTIFIER_HINTS) {
    if (lower.includes(hint)) {
      return false;
    }
  }
  if (shannonEntropyPerChar(raw) < MIN_PSEUDONYM_ENTROPY_BITS) {
    return false;
  }
  return true;
}

/**
 * Convenience wrapper that pulls a named claim out of a
 * {@link CredentialView} and runs the pseudonym heuristic on it.
 *
 * `claimKey` is application-defined (e.g. `'com.example/userRef'`)
 * — the SDK has no opinion on claim namespacing. Returns `false`
 * when the claim is missing.
 */
export function claimLooksLikePseudonym(view: CredentialView, claimKey: string): boolean {
  return looksLikePseudonym(getClaim(view.claims, claimKey));
}

/**
 * Strict-mode counterpart for verifiers that want a hard fail on
 * suspicious values rather than a boolean to act on. The thrown
 * `Error` carries the original value (so callers can log it) but
 * does not embed the heuristic decision rule.
 */
export function assertLooksLikePseudonym(raw: string | undefined | null): void {
  if (!looksLikePseudonym(raw)) {
    throw new Error(
      `assertLooksLikePseudonym: value "${String(raw)}" failed the pseudonym heuristic — looks like a stable identifier rather than a credential-scoped random pseudonym (CIP #204 operator design constraints).`,
    );
  }
}
