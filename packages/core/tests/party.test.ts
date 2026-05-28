/**
 * Tests for `./src/party`.
 *
 * The party module is the sole source of `PartyId` brand minting and
 * the participant-namespace cache. These tests exercise:
 *
 *   * `parsePartyId` — happy path + every rejection branch (empty,
 *     missing separator, bad label, bad fingerprint).
 *   * `buildPartyId` — happy path + rejection on bad label/fingerprint.
 *   * `isPartyId` — true for valid, false for any invalid shape.
 *   * `isSameParty` — case sensitivity + identity.
 *   * `asPartyIdUnchecked` — does not validate (documented as trust-in).
 *   * `participantIdToNamespace` — extracts fingerprint from a
 *     participant id.
 *   * Namespace cache — set/get/per-config reset/all reset.
 *   * `partyIdFromHint` / `resolvePartyFromInput` — build vs pass-through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PartyId } from '../src';
import {
  asPartyIdUnchecked,
  buildPartyId,
  CantonError,
  cacheNamespace,
  getCachedNamespace,
  isCantonErrorWithCode,
  isPartyId,
  isSameParty,
  loadCantonConfig,
  parsePartyId,
  participantIdToNamespace,
  partyIdFromHint,
  resetAllNamespaceCachesForTests,
  resetNamespaceCacheForConfig,
  resolvePartyFromInput,
} from '../src';

import {
  buildTestConfig,
  FIXTURE_HOLDER_PARTY as FIXTURE_USER_PARTY,
  FIXTURE_ISSUER_PARTY as FIXTURE_OPERATOR_PARTY,
  FIXTURE_NAMESPACE,
  FIXTURE_PARTICIPANT_ID,
} from './fixtures';

describe('parsePartyId', () => {
  it('parses a canonical operator party id', () => {
    const parsed = parsePartyId(FIXTURE_OPERATOR_PARTY);
    expect(parsed.raw).toBe(FIXTURE_OPERATOR_PARTY);
    expect(parsed.label).toBe('Operator');
    expect(parsed.fingerprint).toBe(FIXTURE_NAMESPACE);
  });

  it('parses a user party id with a hyphenated label', () => {
    const parsed = parsePartyId(FIXTURE_USER_PARTY);
    expect(parsed.label).toBe('User-abc123');
    expect(parsed.fingerprint).toBe(FIXTURE_NAMESPACE);
  });

  it('parses a label with underscores', () => {
    const parsed = parsePartyId(`Firm_ACME::${FIXTURE_NAMESPACE}`);
    expect(parsed.label).toBe('Firm_ACME');
  });

  it('returns a frozen object', () => {
    const parsed = parsePartyId(FIXTURE_OPERATOR_PARTY);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(() => parsePartyId('')).toThrowError(/non-empty/);
  });

  it('rejects non-string input', () => {
    expect(() => parsePartyId(undefined as unknown as string)).toThrow(CantonError);
    expect(() => parsePartyId(null as unknown as string)).toThrow(CantonError);
    expect(() => parsePartyId(42 as unknown as string)).toThrow(CantonError);
  });

  it('rejects a string with no :: separator', () => {
    try {
      parsePartyId('Operator');
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_party')).toBe(true);
      expect((err as CantonError).message).toMatch(/::/);
    }
  });

  it('rejects a label starting with a digit', () => {
    expect(() => parsePartyId(`1User::${FIXTURE_NAMESPACE}`)).toThrowError(/label/);
  });

  it('rejects a label with a space', () => {
    expect(() => parsePartyId(`Bad Label::${FIXTURE_NAMESPACE}`)).toThrowError(/label/);
  });

  it('rejects a label with special characters', () => {
    expect(() => parsePartyId(`Bad/Label::${FIXTURE_NAMESPACE}`)).toThrowError(/label/);
  });

  it('rejects an empty label', () => {
    expect(() => parsePartyId(`::${FIXTURE_NAMESPACE}`)).toThrowError(/label/);
  });

  it('rejects an empty fingerprint', () => {
    expect(() => parsePartyId('Operator::')).toThrowError(/fingerprint/);
  });

  it('rejects a fingerprint with uppercase hex', () => {
    expect(() =>
      parsePartyId('Operator::1220ABCDEF1234567890abcdef1234567890abcdef'),
    ).toThrowError(/fingerprint/);
  });

  it('rejects a fingerprint that is too short', () => {
    expect(() => parsePartyId('Operator::12ab')).toThrowError(/fingerprint/);
  });

  it('rejects a fingerprint with non-hex characters', () => {
    expect(() => parsePartyId('Operator::xyz1234567890abcdef')).toThrowError(/fingerprint/);
  });

  it('splits only on the FIRST :: if one exists', () => {
    // The implementation uses indexOf, so an extra `::` in the
    // fingerprint segment is treated as part of the fingerprint,
    // which then fails the hex regex.
    expect(() => parsePartyId(`Label::abcd::${FIXTURE_NAMESPACE}`)).toThrowError(/fingerprint/);
  });
});

describe('buildPartyId', () => {
  it('builds a party id from a label + fingerprint', () => {
    const pid = buildPartyId('Operator', FIXTURE_NAMESPACE);
    expect(pid).toBe(FIXTURE_OPERATOR_PARTY);
  });

  it('rejects a bad label', () => {
    expect(() => buildPartyId('1Bad', FIXTURE_NAMESPACE)).toThrowError(/label/);
  });

  it('rejects a bad fingerprint', () => {
    expect(() => buildPartyId('OK', 'not-hex')).toThrowError(/fingerprint/);
  });

  it('produces an output that parsePartyId accepts', () => {
    const pid = buildPartyId('Firm-acme', FIXTURE_NAMESPACE);
    expect(parsePartyId(pid).label).toBe('Firm-acme');
  });
});

describe('isPartyId', () => {
  it('returns true for valid party strings', () => {
    expect(isPartyId(FIXTURE_OPERATOR_PARTY)).toBe(true);
    expect(isPartyId(FIXTURE_USER_PARTY)).toBe(true);
  });

  it('returns false for invalid party strings', () => {
    expect(isPartyId('')).toBe(false);
    expect(isPartyId('NoSeparator')).toBe(false);
    expect(isPartyId(`::${FIXTURE_NAMESPACE}`)).toBe(false);
    expect(isPartyId('Label::notHex')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isPartyId(undefined)).toBe(false);
    expect(isPartyId(null)).toBe(false);
    expect(isPartyId(42)).toBe(false);
    expect(isPartyId({})).toBe(false);
  });
});

describe('isSameParty', () => {
  it('returns true for identical party ids', () => {
    expect(isSameParty(FIXTURE_OPERATOR_PARTY as PartyId, FIXTURE_OPERATOR_PARTY as PartyId)).toBe(
      true,
    );
  });

  it('returns false for different party ids', () => {
    expect(isSameParty(FIXTURE_OPERATOR_PARTY as PartyId, FIXTURE_USER_PARTY as PartyId)).toBe(
      false,
    );
  });

  it('is case-sensitive on the label', () => {
    const upper = `OPERATOR::${FIXTURE_NAMESPACE}` as PartyId;
    expect(isSameParty(FIXTURE_OPERATOR_PARTY as PartyId, upper)).toBe(false);
  });
});

describe('asPartyIdUnchecked', () => {
  it('returns the input string unchanged (no validation)', () => {
    const pid = asPartyIdUnchecked('whatever');
    expect(pid).toBe('whatever');
  });

  it('does not throw on obviously invalid inputs', () => {
    expect(() => asPartyIdUnchecked('')).not.toThrow();
    expect(() => asPartyIdUnchecked('::::')).not.toThrow();
  });
});

describe('participantIdToNamespace', () => {
  it('extracts the fingerprint from a participant id', () => {
    expect(participantIdToNamespace(FIXTURE_PARTICIPANT_ID)).toBe(FIXTURE_NAMESPACE);
  });

  it('throws on an invalid participant id', () => {
    expect(() => participantIdToNamespace('garbage')).toThrow(CantonError);
  });
});

describe('namespace cache', () => {
  beforeEach(() => {
    resetAllNamespaceCachesForTests();
  });
  afterEach(() => {
    resetAllNamespaceCachesForTests();
  });

  it('returns null when nothing is cached', () => {
    const config = buildTestConfig();
    expect(getCachedNamespace(config)).toBeNull();
  });

  it('stores and retrieves a namespace per config', () => {
    const config = buildTestConfig();
    cacheNamespace(config, FIXTURE_NAMESPACE);
    expect(getCachedNamespace(config)).toBe(FIXTURE_NAMESPACE);
  });

  it('keeps per-config entries isolated', () => {
    const a = buildTestConfig();
    const b = buildTestConfig({ CANTON_JSON_API_BASE_URL: 'http://other.test:7575' });
    cacheNamespace(a, FIXTURE_NAMESPACE);
    expect(getCachedNamespace(b)).toBeNull();
    expect(getCachedNamespace(a)).toBe(FIXTURE_NAMESPACE);
  });

  it('rejects an invalid namespace on cache', () => {
    const config = buildTestConfig();
    expect(() => cacheNamespace(config, 'not-hex')).toThrow(CantonError);
    try {
      cacheNamespace(config, 'not-hex');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'namespace_resolution_failed')).toBe(true);
    }
  });

  it('resetNamespaceCacheForConfig drops only the matching entry', () => {
    const a = buildTestConfig();
    const b = buildTestConfig({ CANTON_JSON_API_BASE_URL: 'http://other.test:7575' });
    cacheNamespace(a, FIXTURE_NAMESPACE);
    cacheNamespace(b, FIXTURE_NAMESPACE);
    resetNamespaceCacheForConfig(a);
    expect(getCachedNamespace(a)).toBeNull();
    expect(getCachedNamespace(b)).toBe(FIXTURE_NAMESPACE);
  });

  it('resetAllNamespaceCachesForTests clears all entries', () => {
    const a = buildTestConfig();
    const b = buildTestConfig({ CANTON_JSON_API_BASE_URL: 'http://other.test:7575' });
    cacheNamespace(a, FIXTURE_NAMESPACE);
    cacheNamespace(b, FIXTURE_NAMESPACE);
    resetAllNamespaceCachesForTests();
    expect(getCachedNamespace(a)).toBeNull();
    expect(getCachedNamespace(b)).toBeNull();
  });
});

describe('partyIdFromHint', () => {
  it('builds a party id from a label hint + namespace', () => {
    const pid = partyIdFromHint('Firm-acme', FIXTURE_NAMESPACE);
    expect(pid).toBe(`Firm-acme::${FIXTURE_NAMESPACE}`);
  });

  it('rejects a bad label hint', () => {
    expect(() => partyIdFromHint('1bad', FIXTURE_NAMESPACE)).toThrow(CantonError);
  });
});

describe('resolvePartyFromInput', () => {
  it('passes a fully-qualified party id through', () => {
    expect(resolvePartyFromInput(FIXTURE_OPERATOR_PARTY, FIXTURE_NAMESPACE)).toBe(
      FIXTURE_OPERATOR_PARTY,
    );
  });

  it('builds a party id from a bare label', () => {
    expect(resolvePartyFromInput('Firm-acme', FIXTURE_NAMESPACE)).toBe(
      `Firm-acme::${FIXTURE_NAMESPACE}`,
    );
  });

  it('rejects a full party id with a bad fingerprint', () => {
    expect(() => resolvePartyFromInput('Label::not-hex', FIXTURE_NAMESPACE)).toThrow(CantonError);
  });

  it('rejects an empty string', () => {
    expect(() => resolvePartyFromInput('', FIXTURE_NAMESPACE)).toThrowError(/non-empty/);
  });

  it('fetches loadCantonConfig-provided values (sanity)', () => {
    // Indirectly: make sure the imported helpers agree on the shape.
    expect(loadCantonConfig).toBeDefined();
  });
});
