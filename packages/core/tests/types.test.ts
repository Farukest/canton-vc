/**
 * Tests for `./src/types`.
 *
 * `types.ts` exports:
 *
 *   * Branded identifier types (PartyId, ContractId, …)
 *   * The CIP #204 data shapes (`Claims`, `CredentialView`, `Metadata`)
 *   * Input / result types for the SDK methods
 *   * Generic claim accessors (`getClaim`, `getBoolClaim`, `getIntClaim`)
 *   * `isWithinValidityWindow` lifecycle helper
 *
 * Application-layer vocabulary (KYC level enums, status mappings,
 * DB-side type tables) is deliberately NOT in the SDK — consumers
 * pick their own reverse-DNS namespace per CIP #204 §"Namespacing".
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Brand,
  CantonCredentialPayload,
  Claims,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CredentialView,
  LedgerOffset,
  Metadata,
  PartyId,
  TemplateId,
  UpdateId,
  VerifyCredentialResult,
} from '../src';
import {
  createClaimSchema,
  getBoolClaim,
  getClaim,
  getIntClaim,
  isWithinValidityWindow,
} from '../src';

describe('Brand helper', () => {
  it('is a string at runtime', () => {
    const id = 'abcdef' as Brand<string, 'Test'>;
    expect(typeof id).toBe('string');
    expect(id).toBe('abcdef');
  });

  it('keeps PartyId, ContractId, CommandId distinct at compile time', () => {
    expectTypeOf<PartyId>().not.toEqualTypeOf<ContractId>();
    expectTypeOf<ContractId>().not.toEqualTypeOf<CommandId>();
    expectTypeOf<CommandId>().not.toEqualTypeOf<TemplateId>();
    expectTypeOf<TemplateId>().not.toEqualTypeOf<LedgerOffset>();
    expectTypeOf<LedgerOffset>().not.toEqualTypeOf<UpdateId>();
  });
});

describe('Claims data shape', () => {
  it('accepts a TextMap of string→string values', () => {
    const c: Claims = {
      values: { 'com.example/level': 'Enhanced', 'com.example/score': '92' },
      validFrom: null,
      validUntil: null,
      meta: {},
    };
    expect(c.values['com.example/level']).toBe('Enhanced');
  });

  it('encodes Optional Time fields as string-or-null', () => {
    const c: Claims = {
      values: { 'com.example/k': 'v' },
      validFrom: '2026-04-11T00:00:00Z',
      validUntil: '2027-04-11T00:00:00Z',
      meta: {},
    };
    expect(c.validFrom).toBe('2026-04-11T00:00:00Z');
    expect(c.validUntil).toBe('2027-04-11T00:00:00Z');
  });
});

describe('CredentialView data shape', () => {
  it('is a 1:1 projection of the CIP #204 template payload', () => {
    expectTypeOf<CredentialView>().toEqualTypeOf<CantonCredentialPayload>();
  });

  it('carries admin, issuer, holder, claims, createdAt, expiresAt, meta', () => {
    const v: CredentialView = {
      admin: 'Admin::abc' as PartyId,
      issuer: 'Issuer::abc' as PartyId,
      holder: 'Holder::abc' as PartyId,
      claims: {
        values: { 'com.example/k': 'v' },
        validFrom: null,
        validUntil: null,
        meta: {},
      },
      createdAt: null,
      expiresAt: null,
      meta: {},
    };
    expect(v.admin).toBe('Admin::abc');
  });
});

describe('Metadata', () => {
  it('is a free-form record of string→string', () => {
    const m: Metadata = { 'com.example/foo': 'bar', 'com.example/baz': '123' };
    expect(m['com.example/foo']).toBe('bar');
  });
});

describe('CreateCredentialInput shape', () => {
  it('carries issuerParty, holderParty, adminParty, claims', () => {
    const input: CreateCredentialInput = {
      issuerParty: 'Issuer::abc' as PartyId,
      holderParty: 'Holder::abc' as PartyId,
      adminParty: 'Admin::abc' as PartyId,
      claims: {
        values: { 'com.example/k': 'v' },
        validFrom: null,
        validUntil: null,
        meta: {},
      },
    };
    expect(input.claims.values['com.example/k']).toBe('v');
  });
});

describe('CreateCredentialResult shape', () => {
  it('does not leak hidden fields from branded types', () => {
    const result: CreateCredentialResult = {
      contractId: 'cid' as ContractId,
      commandId: 'cmd' as CommandId,
      updateId: 'upd' as UpdateId,
      recordTime: '2026-04-11T18:00:00.000Z',
      completionOffset: '00000001' as LedgerOffset,
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      contractId: 'cid',
      commandId: 'cmd',
      updateId: 'upd',
      recordTime: '2026-04-11T18:00:00.000Z',
      completionOffset: '00000001',
    });
  });
});

describe('VerifyCredentialResult shape', () => {
  it('exposes the view but no derived `verified` boolean', () => {
    expectTypeOf<VerifyCredentialResult>().toMatchTypeOf<{
      view: CredentialView;
      contractId: ContractId;
    }>();
    // The result type intentionally has no `verified` field — lifecycle
    // interpretation is up to the caller.
    expectTypeOf<VerifyCredentialResult>().not.toMatchTypeOf<{ verified: boolean }>();
  });
});

describe('createClaimSchema', () => {
  it('builds a frozen object of namespaced keys', () => {
    const k = createClaimSchema('io.example', ['level', 'userRef'] as const);
    expect(k.level).toBe('io.example/level');
    expect(k.userRef).toBe('io.example/userRef');
    expect(Object.isFrozen(k)).toBe(true);
  });

  it('handles arbitrary reverse-DNS namespace shapes', () => {
    const a = createClaimSchema('com.acme.kyc', ['humanScore'] as const);
    expect(a.humanScore).toBe('com.acme.kyc/humanScore');
    const b = createClaimSchema('io.org-with-dash', ['proofHash'] as const);
    expect(b.proofHash).toBe('io.org-with-dash/proofHash');
  });

  it('handles an empty key list', () => {
    const k = createClaimSchema('io.example', [] as const);
    expect(k).toEqual({});
    expect(Object.isFrozen(k)).toBe(true);
  });

  it('rejects an empty namespace', () => {
    expect(() => createClaimSchema('', ['level'] as const)).toThrowError(/non-empty/);
  });

  it('rejects an empty key', () => {
    expect(() => createClaimSchema('io.example', ['level', ''] as const)).toThrowError(/non-empty/);
  });

  it('preserves typed key access at compile time', () => {
    const k = createClaimSchema('io.example', ['level', 'userRef'] as const);
    // Compile-time check — `k.level` and `k.userRef` are statically known;
    // a typo like `k.levle` would be a type error.
    expectTypeOf(k).toEqualTypeOf<Readonly<{ level: string; userRef: string }>>();
  });
});

describe('getClaim', () => {
  const claims: Claims = {
    values: {
      'com.example/level': 'Enhanced',
      'com.example/score': '92',
      'com.example/flag': 'true',
    },
    validFrom: null,
    validUntil: null,
    meta: {},
  };

  it('returns the value for a known key', () => {
    expect(getClaim(claims, 'com.example/level')).toBe('Enhanced');
  });

  it('returns undefined for an unknown key', () => {
    expect(getClaim(claims, 'com.example/missing')).toBeUndefined();
  });
});

describe('getBoolClaim', () => {
  const claims: Claims = {
    values: {
      'com.example/yes': 'true',
      'com.example/no': 'false',
      'com.example/garbage': 'maybe',
    },
    validFrom: null,
    validUntil: null,
    meta: {},
  };

  it('decodes "true" → true', () => {
    expect(getBoolClaim(claims, 'com.example/yes')).toBe(true);
  });

  it('decodes "false" → false', () => {
    expect(getBoolClaim(claims, 'com.example/no')).toBe(false);
  });

  it('returns undefined for non-boolean text', () => {
    expect(getBoolClaim(claims, 'com.example/garbage')).toBeUndefined();
  });

  it('returns undefined for missing keys', () => {
    expect(getBoolClaim(claims, 'com.example/missing')).toBeUndefined();
  });
});

describe('getIntClaim', () => {
  const claims: Claims = {
    values: {
      'com.example/n': '92',
      'com.example/neg': '-5',
      'com.example/garbage': '92.5',
    },
    validFrom: null,
    validUntil: null,
    meta: {},
  };

  it('decodes integer-shaped text', () => {
    expect(getIntClaim(claims, 'com.example/n')).toBe(92);
    expect(getIntClaim(claims, 'com.example/neg')).toBe(-5);
  });

  it('returns undefined for non-integer text', () => {
    expect(getIntClaim(claims, 'com.example/garbage')).toBeUndefined();
  });

  it('returns undefined for missing keys', () => {
    expect(getIntClaim(claims, 'com.example/missing')).toBeUndefined();
  });
});

describe('isWithinValidityWindow', () => {
  const baseView = (claims: Claims, expiresAt: string | null): CredentialView => ({
    admin: 'Admin::abc' as PartyId,
    issuer: 'Issuer::abc' as PartyId,
    holder: 'Holder::abc' as PartyId,
    claims,
    createdAt: null,
    expiresAt,
    meta: {},
  });

  it('returns true when no timestamps are set', () => {
    const view = baseView(
      { values: { 'com.example/k': 'v' }, validFrom: null, validUntil: null, meta: {} },
      null,
    );
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:00Z'))).toBe(true);
  });

  it('respects claims.validUntil upper bound', () => {
    const view = baseView(
      {
        values: { 'com.example/k': 'v' },
        validFrom: null,
        validUntil: '2026-04-11T18:00:00Z',
        meta: {},
      },
      null,
    );
    expect(isWithinValidityWindow(view, new Date('2026-04-11T17:59:00Z'))).toBe(true);
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:00Z'))).toBe(true);
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:01Z'))).toBe(false);
  });

  it('respects claims.validFrom lower bound', () => {
    const view = baseView(
      {
        values: { 'com.example/k': 'v' },
        validFrom: '2026-04-11T18:00:00Z',
        validUntil: null,
        meta: {},
      },
      null,
    );
    expect(isWithinValidityWindow(view, new Date('2026-04-11T17:59:59Z'))).toBe(false);
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:00Z'))).toBe(true);
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:01Z'))).toBe(true);
  });

  it('respects the template-level expiresAt upper bound', () => {
    const view = baseView(
      { values: { 'com.example/k': 'v' }, validFrom: null, validUntil: null, meta: {} },
      '2026-04-11T18:00:00Z',
    );
    expect(isWithinValidityWindow(view, new Date('2026-04-11T17:59:00Z'))).toBe(true);
    expect(isWithinValidityWindow(view, new Date('2026-04-11T18:00:01Z'))).toBe(false);
  });
});
