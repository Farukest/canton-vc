/**
 * Canton party identifier utilities.
 *
 * Canton party IDs follow the `<Label>::<Fingerprint>` shape where:
 *
 *   * `Label` is an alphanumeric string chosen by the caller at
 *     allocation time (`Issuer`, `FirmAcme`, `Holder-1234`).
 *     Canton permits underscores and dashes, but we take a
 *     conservative approach and forbid a handful of control
 *     characters that would be hard to reason about.
 *
 *   * `Fingerprint` is the protocol-version-tagged hex digest of the
 *     participant's signing key. On Canton 3.4 MainNet this looks
 *     like `1220deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0011`
 *     — a 4-hex-char version prefix followed by the 64-hex-char
 *     SHA-256 digest.
 *
 * This module owns *all* party-id parsing. Nothing else in the
 * Canton client — including the config loader — should reach into a
 * party string; every helper either constructs a branded `PartyId`
 * via `buildPartyId()` / `parsePartyId()` or treats it as opaque.
 *
 * Namespace resolution is also centralized here: the bootstrap call
 * to `/v2/parties/participant-id` caches the namespace for the
 * process so subsequent lookups are free. The cache is keyed per
 * `CantonConfig` so multiple client instances (e.g. in tests) never
 * mix namespaces.
 */

import type { CantonConfig } from './config';
import { CantonError } from './errors';
import type { PartyId } from './types';

/* ---------- Regexes ---------- */

/**
 * Party-id separator. We split on the first `::` we see — fingerprints
 * themselves never contain `::`.
 */
const PARTY_SEPARATOR = '::';

/**
 * Party label: starts with an ASCII letter, followed by 0..254
 * alphanumerics / underscore / hyphen. The outer length cap (255)
 * matches the Canton protocol limit.
 */
const PARTY_LABEL_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/;

/**
 * Party fingerprint: hex, at least 16 characters long, at most 256.
 * The canonical MainNet fingerprint is 68 chars (`1220` prefix + 64
 * hex digits), but we keep the range wide so the regex tolerates
 * protocol version bumps.
 */
const PARTY_FINGERPRINT_REGEX = /^[0-9a-f]{16,256}$/;

/* ---------- Parsed shape ---------- */

/**
 * Structured view of a Canton party id. `raw` is the original string
 * (branded as `PartyId`) so callers can pass it straight through to
 * commands without re-stringifying.
 */
export interface ParsedPartyId {
  readonly raw: PartyId;
  readonly label: string;
  readonly fingerprint: string;
}

/* ---------- Construction ---------- */

/**
 * Parse a raw party-id string, returning a structured view on
 * success and throwing `CantonError('invalid_party', …)` on failure.
 *
 * Accepted input: `Label::fingerprint` where both segments match the
 * regexes defined at the top of the module.
 */
export function parsePartyId(raw: string): ParsedPartyId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CantonError('invalid_party', 'Party ID must be a non-empty string.');
  }
  const separatorIndex = raw.indexOf(PARTY_SEPARATOR);
  if (separatorIndex === -1) {
    throw new CantonError(
      'invalid_party',
      `Party ID "${raw}" is missing the "::" separator between label and fingerprint.`,
    );
  }
  const label = raw.slice(0, separatorIndex);
  const fingerprint = raw.slice(separatorIndex + PARTY_SEPARATOR.length);
  if (!PARTY_LABEL_REGEX.test(label)) {
    throw new CantonError(
      'invalid_party',
      `Party ID "${raw}" has an invalid label. Must start with a letter and contain only alphanumerics, underscores, or hyphens.`,
    );
  }
  if (!PARTY_FINGERPRINT_REGEX.test(fingerprint)) {
    throw new CantonError(
      'invalid_party',
      `Party ID "${raw}" has an invalid fingerprint. Must be 16..256 lowercase hex characters.`,
    );
  }
  return Object.freeze({
    raw: raw as PartyId,
    label,
    fingerprint,
  });
}

/**
 * Build a `PartyId` from its parts. Throws on invalid label or
 * fingerprint. Used when constructing a user party from a hint plus
 * a resolved namespace.
 */
export function buildPartyId(label: string, fingerprint: string): PartyId {
  if (!PARTY_LABEL_REGEX.test(label)) {
    throw new CantonError(
      'invalid_party',
      `Cannot build party ID: invalid label "${label}". Must start with a letter and contain only alphanumerics, underscores, or hyphens.`,
    );
  }
  if (!PARTY_FINGERPRINT_REGEX.test(fingerprint)) {
    throw new CantonError(
      'invalid_party',
      `Cannot build party ID: invalid fingerprint "${fingerprint}". Must be 16..256 lowercase hex characters.`,
    );
  }
  return `${label}${PARTY_SEPARATOR}${fingerprint}` as PartyId;
}

/**
 * Loose party-id test — non-throwing. Useful in type guards where
 * we want to accept a raw string only if it already carries a valid
 * shape.
 */
export function isPartyId(value: unknown): value is PartyId {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    parsePartyId(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare two party ids for equality. Canton party ids are strictly
 * case-sensitive, so this is a plain `===` — we define it anyway so
 * call sites don't have to remember that rule.
 */
export function isSameParty(a: PartyId, b: PartyId): boolean {
  return a === b;
}

/**
 * Narrow a raw string into a branded `PartyId` without parsing.
 *
 * **Only** for trusted inputs (e.g. values already persisted in the
 * DB after having been validated once). Use `parsePartyId()` for
 * anything coming from an HTTP request or a Canton response body.
 */
export function asPartyIdUnchecked(value: string): PartyId {
  return value as PartyId;
}

/* ---------- Namespace resolution ---------- */

/**
 * Per-config cache of the participant namespace. Keyed by the
 * `CantonConfig` reference so tests that build multiple configs
 * never see a stale entry. Plain `Map` (not `WeakMap`) so we can
 * iterate it in tests via `resetAllNamespaceCachesForTests`; the
 * long-lived config singleton keeps its entry for the process
 * lifetime, which is the desired behavior in production.
 */
const namespaceCache = new Map<CantonConfig, string>();

/**
 * Extract the namespace fragment from a participant id. Participant
 * ids on Canton follow the same `<label>::<fingerprint>` shape, so
 * we reuse `parsePartyId` and pull the fingerprint out.
 */
export function participantIdToNamespace(participantId: string): string {
  const parsed = parsePartyId(participantId);
  return parsed.fingerprint;
}

/**
 * Populate the namespace cache for a given config. Called by the
 * HTTP layer after it has fetched the participant id — we keep this
 * import-free on HTTP so the party module stays pure.
 */
export function cacheNamespace(config: CantonConfig, namespace: string): void {
  if (!PARTY_FINGERPRINT_REGEX.test(namespace)) {
    throw new CantonError(
      'namespace_resolution_failed',
      `Cannot cache namespace "${namespace}": not a valid Canton fingerprint.`,
    );
  }
  namespaceCache.set(config, namespace);
}

/**
 * Read a cached namespace. Returns `null` when no entry exists —
 * the caller is responsible for fetching and then caching.
 */
export function getCachedNamespace(config: CantonConfig): string | null {
  return namespaceCache.get(config) ?? null;
}

/**
 * Drop the cached namespace for a config. Used by tests; callers in
 * production should never need this.
 */
export function resetNamespaceCacheForConfig(config: CantonConfig): void {
  namespaceCache.delete(config);
}

/**
 * Clear the entire namespace cache. Used by the top-level test
 * reset hook.
 */
export function resetAllNamespaceCachesForTests(): void {
  namespaceCache.clear();
}

/* ---------- Resolution from a hint ---------- */

/**
 * Construct a full party id from a hint (just the label) and a
 * namespace (fingerprint). Used when the route layer has a label
 * like `Holder-abc123` and needs the full party id for a Daml command.
 */
export function partyIdFromHint(labelHint: string, namespace: string): PartyId {
  return buildPartyId(labelHint, namespace);
}

/**
 * If the caller already passed a full party id (contains `::`),
 * return it as-is; otherwise treat it as a label hint and build the
 * full party id against the provided namespace. This mirrors the
 * legacy `resolvePartyIdentifier` helper but without the on-demand
 * allocation — that belongs in the higher-level `client.ts`.
 */
export function resolvePartyFromInput(input: string, namespace: string): PartyId {
  if (typeof input !== 'string' || input.length === 0) {
    throw new CantonError('invalid_party', 'Party input must be a non-empty string.');
  }
  if (input.includes(PARTY_SEPARATOR)) {
    return parsePartyId(input).raw;
  }
  return partyIdFromHint(input, namespace);
}
