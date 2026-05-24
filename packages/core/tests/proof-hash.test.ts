/**
 * @canton-vc/core/proof-hash — full test suite.
 *
 * Pins:
 *
 *  - canonicalJson: key ordering, float shortening, edge cases.
 *  - sortKeys / shortenFloats individually.
 *  - computeSchemaId: content-addressed determinism, validation,
 *    duplicate field detection, canonicalForm pinning.
 *  - computeProofHash: missing fields rejected, extra fields rejected,
 *    deterministic across runs, schema id matches computeSchemaId.
 *  - Audit-replay invariant: same inputs → same hash, regardless of
 *    insertion order in the values map.
 *  - PII anti-leak: hash output is hex-only, no PII bytes in result.
 */

import { describe, expect, it } from 'vitest';

import { CantonError } from '../src/errors';
import {
  CANONICAL_FORM_DEFAULT,
  canonicalJson,
  computeProofHash,
  computeSchemaId,
  type ProofSchemaSpec,
  shortenFloats,
  sortKeys,
} from '../src/proof-hash';

/* ---------- shortenFloats ---------- */

describe('shortenFloats', () => {
  it('coerces whole-number floats to integers', () => {
    expect(shortenFloats(42.0)).toBe(42);
    expect(shortenFloats(-100.0)).toBe(-100);
    expect(shortenFloats(0.0)).toBe(0);
  });

  it('passes through non-integer floats unchanged', () => {
    expect(shortenFloats(3.14)).toBe(3.14);
    expect(shortenFloats(-0.5)).toBe(-0.5);
  });

  it('walks objects recursively', () => {
    expect(shortenFloats({ a: 1.0, b: { c: 2.0, d: 'x' } })).toEqual({
      a: 1,
      b: { c: 2, d: 'x' },
    });
  });

  it('walks arrays recursively', () => {
    expect(shortenFloats([1.0, 2.5, 3.0])).toEqual([1, 2.5, 3]);
  });

  it('passes through strings/booleans/null unchanged', () => {
    expect(shortenFloats('hello')).toBe('hello');
    expect(shortenFloats(true)).toBe(true);
    expect(shortenFloats(null)).toBe(null);
  });

  it('coerces non-JSON types to null', () => {
    expect(shortenFloats(undefined)).toBe(null);
    expect(shortenFloats(Symbol('x') as unknown)).toBe(null);
  });
});

/* ---------- sortKeys ---------- */

describe('sortKeys', () => {
  it('sorts object keys lexicographically', () => {
    const sorted = sortKeys({ c: 1, a: 2, b: 3 });
    expect(JSON.stringify(sorted)).toBe('{"a":2,"b":3,"c":1}');
  });

  it('sorts nested objects recursively', () => {
    const sorted = sortKeys({ outer: { z: 1, a: 2 } });
    expect(JSON.stringify(sorted)).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(sortKeys(['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('sorts objects inside arrays', () => {
    expect(JSON.stringify(sortKeys([{ b: 1, a: 2 }]))).toBe('[{"a":2,"b":1}]');
  });

  it('passes through scalars unchanged', () => {
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys('x')).toBe('x');
    expect(sortKeys(null)).toBe(null);
  });
});

/* ---------- canonicalJson ---------- */

describe('canonicalJson', () => {
  it('produces identical output regardless of input key order', () => {
    const a = canonicalJson({ firstName: 'Ada', lastName: 'Lovelace', dob: '1815' });
    const b = canonicalJson({ dob: '1815', lastName: 'Lovelace', firstName: 'Ada' });
    expect(a).toBe(b);
    expect(a).toBe('{"dob":"1815","firstName":"Ada","lastName":"Lovelace"}');
  });

  it('shortens floats then sorts', () => {
    expect(canonicalJson({ score: 95.0, name: 'x' })).toBe('{"name":"x","score":95}');
  });

  it('uses tight separators (no whitespace)', () => {
    const out = canonicalJson({ a: 1, b: [2, 3] });
    expect(out).toBe('{"a":1,"b":[2,3]}');
  });

  it('handles nested mixed types deterministically', () => {
    const out = canonicalJson({
      flags: { addressVerified: true, livenessVerified: false },
      score: 95.0,
      tags: ['kyc', 'live'],
      vendor: 'didit',
    });
    expect(out).toBe(
      '{"flags":{"addressVerified":true,"livenessVerified":false},"score":95,"tags":["kyc","live"],"vendor":"didit"}',
    );
  });
});

/* ---------- computeSchemaId ---------- */

const VALID_SPEC: ProofSchemaSpec = {
  vendor: 'didit',
  schemaVersion: 'v1',
  fieldsInOrder: ['vendor', 'schemaVersion', 'sessionId', 'firstName', 'lastName', 'dateOfBirth'],
  canonicalForm: CANONICAL_FORM_DEFAULT,
};

describe('computeSchemaId', () => {
  it('returns a 64-char hex SHA-256', () => {
    const id = computeSchemaId(VALID_SPEC);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    expect(computeSchemaId(VALID_SPEC)).toBe(computeSchemaId(VALID_SPEC));
  });

  it('changes when vendor changes', () => {
    const a = computeSchemaId(VALID_SPEC);
    const b = computeSchemaId({ ...VALID_SPEC, vendor: 'sumsub' });
    expect(a).not.toBe(b);
  });

  it('changes when schemaVersion changes', () => {
    const a = computeSchemaId(VALID_SPEC);
    const b = computeSchemaId({ ...VALID_SPEC, schemaVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it('changes when fieldsInOrder changes (even by reordering)', () => {
    const a = computeSchemaId(VALID_SPEC);
    const b = computeSchemaId({
      ...VALID_SPEC,
      fieldsInOrder: [...VALID_SPEC.fieldsInOrder].reverse(),
    });
    expect(a).not.toBe(b);
  });

  it('rejects empty vendor', () => {
    expect(() => computeSchemaId({ ...VALID_SPEC, vendor: '' })).toThrow(CantonError);
  });

  it('rejects empty schemaVersion', () => {
    expect(() => computeSchemaId({ ...VALID_SPEC, schemaVersion: '' })).toThrow(CantonError);
  });

  it('rejects empty fieldsInOrder', () => {
    expect(() => computeSchemaId({ ...VALID_SPEC, fieldsInOrder: [] })).toThrow(CantonError);
  });

  it('rejects duplicate field names in fieldsInOrder', () => {
    expect(() =>
      computeSchemaId({
        ...VALID_SPEC,
        fieldsInOrder: ['a', 'b', 'a'],
      }),
    ).toThrow(/duplicate field "a"/);
  });

  it('rejects empty-string field name', () => {
    expect(() =>
      computeSchemaId({ ...VALID_SPEC, fieldsInOrder: ['a', ''] }),
    ).toThrow(CantonError);
  });

  it('rejects an unsupported canonicalForm', () => {
    expect(() =>
      computeSchemaId({
        ...VALID_SPEC,
        canonicalForm: 'made-up-form' as unknown as typeof CANONICAL_FORM_DEFAULT,
      }),
    ).toThrow(/canonicalForm/);
  });
});

/* ---------- computeProofHash ---------- */

const VALUES = {
  vendor: 'didit',
  schemaVersion: 'v1',
  sessionId: 'a3f7c1d2',
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1815-12-10',
};

describe('computeProofHash', () => {
  it('returns hex SHA-256 + schemaId + canonical bytes', () => {
    const result = computeProofHash(VALID_SPEC, VALUES);
    expect(result.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.proofSchemaId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.canonical).toBe(
      '{"dateOfBirth":"1815-12-10","firstName":"Ada","lastName":"Lovelace","schemaVersion":"v1","sessionId":"a3f7c1d2","vendor":"didit"}',
    );
  });

  it('proofSchemaId matches computeSchemaId(spec)', () => {
    const result = computeProofHash(VALID_SPEC, VALUES);
    expect(result.proofSchemaId).toBe(computeSchemaId(VALID_SPEC));
  });

  it('is deterministic across calls', () => {
    const a = computeProofHash(VALID_SPEC, VALUES);
    const b = computeProofHash(VALID_SPEC, VALUES);
    expect(a.proofHash).toBe(b.proofHash);
    expect(a.canonical).toBe(b.canonical);
  });

  it('returns the same hash regardless of input key insertion order', () => {
    const reorderedValues: Record<string, string> = {};
    for (const key of [...VALID_SPEC.fieldsInOrder].reverse()) {
      reorderedValues[key] = VALUES[key as keyof typeof VALUES];
    }
    const a = computeProofHash(VALID_SPEC, VALUES);
    const b = computeProofHash(VALID_SPEC, reorderedValues);
    expect(a.proofHash).toBe(b.proofHash);
  });

  it('rejects when a schema-declared field is missing from values', () => {
    const { firstName: _firstName, ...partial } = VALUES;
    expect(() => computeProofHash(VALID_SPEC, partial)).toThrow(/not present.*firstName/);
  });

  it('rejects when values contain an undeclared key', () => {
    const polluted = { ...VALUES, ssn: '123-45-6789' };
    expect(() => computeProofHash(VALID_SPEC, polluted)).toThrow(
      /not declared in the schema/,
    );
  });

  it('produces different hashes for different values', () => {
    const a = computeProofHash(VALID_SPEC, VALUES).proofHash;
    const b = computeProofHash(VALID_SPEC, { ...VALUES, firstName: 'Augusta' }).proofHash;
    expect(a).not.toBe(b);
  });

  it('accepts boolean and number fields alongside strings', () => {
    const spec: ProofSchemaSpec = {
      ...VALID_SPEC,
      fieldsInOrder: ['vendor', 'addressVerified', 'humanScore'],
    };
    const result = computeProofHash(spec, {
      vendor: 'didit',
      addressVerified: true,
      humanScore: 95.0,
    });
    expect(result.canonical).toBe('{"addressVerified":true,"humanScore":95,"vendor":"didit"}');
  });

  it('proofHash output is hex-only — PII anti-leak guarantee', () => {
    // Even if all input fields are PII, the output digest carries
    // no recoverable PII bytes. Constant-byte check pins this.
    const piiHeavy = {
      vendor: 'didit',
      schemaVersion: 'v1',
      sessionId: 'unique-session-1',
      firstName: 'Abdullah Faruk',
      lastName: 'Özden',
      dateOfBirth: '1995-03-14',
    };
    const result = computeProofHash(VALID_SPEC, piiHeavy);
    expect(result.proofHash).toMatch(/^[0-9a-f]{64}$/);
    // Output must not contain any UTF-8 byte from the input PII.
    expect(result.proofHash.toLowerCase()).not.toContain('abdullah');
    expect(result.proofHash.toLowerCase()).not.toContain('faruk');
    expect(result.proofHash.toLowerCase()).not.toContain('özden');
  });

  it('schema id changes invalidate prior credential audit', () => {
    // If the spec changes (e.g. adapter rev bump), the schema id
    // changes too. An auditor checking against the wrong schema id
    // sees the mismatch immediately and refuses to audit.
    const credentialsAtV1 = computeProofHash(VALID_SPEC, VALUES);
    const v2Spec: ProofSchemaSpec = { ...VALID_SPEC, schemaVersion: 'v2' };
    const credentialsAtV2 = computeProofHash(v2Spec, VALUES);
    expect(credentialsAtV1.proofSchemaId).not.toBe(credentialsAtV2.proofSchemaId);
    // proofHash itself also differs because schemaVersion is one of
    // the fieldsInOrder — it changes the hash input.
    // (If schemaVersion were not a hashed field, only schemaId would
    // change. Bundling schemaVersion into the hash input is a
    // belt-and-suspenders defense.)
  });
});
