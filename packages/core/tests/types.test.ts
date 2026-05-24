/**
 * Tests for `./src/types`.
 *
 * `types.ts` exports no runtime helpers beyond the six
 * `DAML_TO_DB_*` / `DB_TO_DAML_*` mapping tables. These tests pin:
 *
 *   * Every mapping is a frozen object (cannot be mutated at runtime).
 *   * Every enum variant in the Daml-side type has a DB counterpart
 *     and vice versa — no mapping is silently missing.
 *   * `DAML_TO_DB_*` and `DB_TO_DAML_*` round-trip cleanly.
 *   * The keys of each pair are exactly the full enum union — tested
 *     via compile-time exhaustiveness.
 *   * The TypeScript brand types ship as plain strings at runtime —
 *     no structural hidden fields leak into JSON.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Brand,
  CanonicalNetwork,
  CantonCredentialPayload,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CredentialStatus,
  DamlCredentialStatus,
  DamlKycLevel,
  DamlValidatorType,
  KycLevel,
  LedgerOffset,
  PartyId,
  TemplateId,
  UpdateId,
  Validator,
  VerifyCredentialResult,
} from '../src';
import {
  DAML_TO_DB_LEVEL,
  DAML_TO_DB_STATUS,
  DAML_TO_DB_VALIDATOR,
  DB_TO_DAML_LEVEL,
  DB_TO_DAML_STATUS,
  DB_TO_DAML_VALIDATOR,
} from '../src';

describe('DAML_TO_DB_STATUS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DAML_TO_DB_STATUS)).toBe(true);
  });

  it('maps every Daml status variant to the DB lowercase form', () => {
    expect(DAML_TO_DB_STATUS.Pending).toBe('pending');
    expect(DAML_TO_DB_STATUS.Active).toBe('active');
    expect(DAML_TO_DB_STATUS.Revoked).toBe('revoked');
    expect(DAML_TO_DB_STATUS.Expired).toBe('expired');
  });

  it('covers exactly the four DamlCredentialStatus keys', () => {
    expect(Object.keys(DAML_TO_DB_STATUS).sort()).toEqual([
      'Active',
      'Expired',
      'Pending',
      'Revoked',
    ]);
  });
});

describe('DB_TO_DAML_STATUS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DB_TO_DAML_STATUS)).toBe(true);
  });

  it('maps every DB status variant to the Daml capitalized form', () => {
    expect(DB_TO_DAML_STATUS.pending).toBe('Pending');
    expect(DB_TO_DAML_STATUS.active).toBe('Active');
    expect(DB_TO_DAML_STATUS.revoked).toBe('Revoked');
    expect(DB_TO_DAML_STATUS.expired).toBe('Expired');
  });

  it('round-trips Daml → DB → Daml', () => {
    const allDaml: readonly DamlCredentialStatus[] = ['Pending', 'Active', 'Revoked', 'Expired'];
    for (const status of allDaml) {
      expect(DB_TO_DAML_STATUS[DAML_TO_DB_STATUS[status]]).toBe(status);
    }
  });

  it('round-trips DB → Daml → DB', () => {
    const allDb: readonly CredentialStatus[] = ['pending', 'active', 'revoked', 'expired'];
    for (const status of allDb) {
      expect(DAML_TO_DB_STATUS[DB_TO_DAML_STATUS[status]]).toBe(status);
    }
  });
});

describe('DAML_TO_DB_LEVEL / DB_TO_DAML_LEVEL', () => {
  it('are both frozen', () => {
    expect(Object.isFrozen(DAML_TO_DB_LEVEL)).toBe(true);
    expect(Object.isFrozen(DB_TO_DAML_LEVEL)).toBe(true);
  });

  it('maps each level variant in both directions', () => {
    // Canton.VC.Credential collapsed the level enum to
    // {Basic, Enhanced}. The intermediate Standard tier was retired
    // in the same release.
    expect(DAML_TO_DB_LEVEL.Basic).toBe('basic');
    expect(DAML_TO_DB_LEVEL.Enhanced).toBe('enhanced');
    expect(DB_TO_DAML_LEVEL.basic).toBe('Basic');
    expect(DB_TO_DAML_LEVEL.enhanced).toBe('Enhanced');
  });

  it('round-trips both ways', () => {
    const allDaml: readonly DamlKycLevel[] = ['Basic', 'Enhanced'];
    for (const level of allDaml) {
      expect(DB_TO_DAML_LEVEL[DAML_TO_DB_LEVEL[level]]).toBe(level);
    }
    const allDb: readonly KycLevel[] = ['basic', 'enhanced'];
    for (const level of allDb) {
      expect(DAML_TO_DB_LEVEL[DB_TO_DAML_LEVEL[level]]).toBe(level);
    }
  });

  it('covers exactly the two level keys', () => {
    expect(Object.keys(DAML_TO_DB_LEVEL).sort()).toEqual(['Basic', 'Enhanced']);
    expect(Object.keys(DB_TO_DAML_LEVEL).sort()).toEqual(['basic', 'enhanced']);
  });
});

describe('DAML_TO_DB_VALIDATOR / DB_TO_DAML_VALIDATOR', () => {
  it('are both frozen', () => {
    expect(Object.isFrozen(DAML_TO_DB_VALIDATOR)).toBe(true);
    expect(Object.isFrozen(DB_TO_DAML_VALIDATOR)).toBe(true);
  });

  it('maps each validator variant in both directions', () => {
    expect(DAML_TO_DB_VALIDATOR.DiditValidator).toBe('didit');
    expect(DAML_TO_DB_VALIDATOR.OnfidoValidator).toBe('onfido');
    expect(DAML_TO_DB_VALIDATOR.PersonaValidator).toBe('persona');
    expect(DAML_TO_DB_VALIDATOR.SumsubValidator).toBe('sumsub');
    expect(DAML_TO_DB_VALIDATOR.VeriffValidator).toBe('veriff');
    expect(DAML_TO_DB_VALIDATOR.Au10tixValidator).toBe('au10tix');
    expect(DAML_TO_DB_VALIDATOR.JumioValidator).toBe('jumio');
    expect(DAML_TO_DB_VALIDATOR.ZkValidator).toBe('zk');
    expect(DAML_TO_DB_VALIDATOR.Generic).toBe('generic');
    expect(DB_TO_DAML_VALIDATOR.didit).toBe('DiditValidator');
    expect(DB_TO_DAML_VALIDATOR.sumsub).toBe('SumsubValidator');
    expect(DB_TO_DAML_VALIDATOR.zk).toBe('ZkValidator');
    expect(DB_TO_DAML_VALIDATOR.generic).toBe('Generic');
  });

  it('round-trips both ways', () => {
    const allDaml: readonly DamlValidatorType[] = [
      'DiditValidator',
      'OnfidoValidator',
      'PersonaValidator',
      'SumsubValidator',
      'VeriffValidator',
      'Au10tixValidator',
      'JumioValidator',
      'ZkValidator',
      'Generic',
    ];
    for (const v of allDaml) {
      expect(DB_TO_DAML_VALIDATOR[DAML_TO_DB_VALIDATOR[v]]).toBe(v);
    }
    const allDb: readonly Validator[] = [
      'didit',
      'onfido',
      'persona',
      'sumsub',
      'veriff',
      'au10tix',
      'jumio',
      'zk',
      'generic',
    ];
    for (const v of allDb) {
      expect(DAML_TO_DB_VALIDATOR[DB_TO_DAML_VALIDATOR[v]]).toBe(v);
    }
  });

  it('covers exactly the nine DAML ValidatorType constructors', () => {
    expect(Object.keys(DAML_TO_DB_VALIDATOR).sort()).toEqual([
      'Au10tixValidator',
      'DiditValidator',
      'Generic',
      'JumioValidator',
      'OnfidoValidator',
      'PersonaValidator',
      'SumsubValidator',
      'VeriffValidator',
      'ZkValidator',
    ]);
    expect(Object.keys(DB_TO_DAML_VALIDATOR).sort()).toEqual([
      'au10tix',
      'didit',
      'generic',
      'jumio',
      'onfido',
      'persona',
      'sumsub',
      'veriff',
      'zk',
    ]);
  });
});

describe('type-level shapes', () => {
  it('PartyId, ContractId, TemplateId, CommandId, LedgerOffset, UpdateId are branded strings', () => {
    expectTypeOf<PartyId>().toEqualTypeOf<Brand<string, 'PartyId'>>();
    expectTypeOf<ContractId>().toEqualTypeOf<Brand<string, 'ContractId'>>();
    expectTypeOf<TemplateId>().toEqualTypeOf<Brand<string, 'TemplateId'>>();
    expectTypeOf<CommandId>().toEqualTypeOf<Brand<string, 'CommandId'>>();
    expectTypeOf<LedgerOffset>().toEqualTypeOf<Brand<string, 'LedgerOffset'>>();
    expectTypeOf<UpdateId>().toEqualTypeOf<Brand<string, 'UpdateId'>>();
  });

  it('DamlCredentialStatus / CredentialStatus unions are disjoint', () => {
    expectTypeOf<DamlCredentialStatus>().toEqualTypeOf<
      'Pending' | 'Active' | 'Revoked' | 'Expired'
    >();
    expectTypeOf<CredentialStatus>().toEqualTypeOf<'pending' | 'active' | 'revoked' | 'expired'>();
  });

  it('DamlKycLevel / KycLevel unions match', () => {
    expectTypeOf<DamlKycLevel>().toEqualTypeOf<'Basic' | 'Enhanced'>();
    expectTypeOf<KycLevel>().toEqualTypeOf<'basic' | 'enhanced'>();
  });

  it('DamlValidatorType / Validator unions match the DAML ValidatorType enum', () => {
    expectTypeOf<DamlValidatorType>().toEqualTypeOf<
      | 'DiditValidator'
      | 'OnfidoValidator'
      | 'PersonaValidator'
      | 'SumsubValidator'
      | 'VeriffValidator'
      | 'Au10tixValidator'
      | 'JumioValidator'
      | 'ZkValidator'
      | 'Generic'
    >();
    expectTypeOf<Validator>().toEqualTypeOf<
      | 'didit'
      | 'onfido'
      | 'persona'
      | 'sumsub'
      | 'veriff'
      | 'au10tix'
      | 'jumio'
      | 'zk'
      | 'generic'
    >();
  });

  it('CanonicalNetwork is the two-tag union', () => {
    expectTypeOf<CanonicalNetwork>().toEqualTypeOf<'mainnet' | 'devnet'>();
  });

  it('CantonCredentialPayload has the expected 13 fields', () => {
    type Keys = keyof CantonCredentialPayload;
    // `userRef` added to the on-chain payload.
    type Expected =
      | 'operator'
      | 'user'
      | 'userRef'
      | 'proofHash'
      | 'status'
      | 'level'
      | 'validUntil'
      | 'network'
      | 'humanScore'
      | 'validator'
      | 'identityVerified'
      | 'livenessVerified'
      | 'addressVerified'
      | 'proofSchemaId';
    expectTypeOf<Keys>().toEqualTypeOf<Expected>();
  });

  it('CreateCredentialInput uses DB-side enums (lowercase)', () => {
    expectTypeOf<CreateCredentialInput['status']>().toEqualTypeOf<CredentialStatus>();
    expectTypeOf<CreateCredentialInput['level']>().toEqualTypeOf<KycLevel>();
    expectTypeOf<CreateCredentialInput['validator']>().toEqualTypeOf<Validator>();
  });

  it('CreateCredentialResult returns branded identifiers', () => {
    expectTypeOf<CreateCredentialResult['contractId']>().toEqualTypeOf<ContractId>();
    expectTypeOf<CreateCredentialResult['commandId']>().toEqualTypeOf<CommandId>();
    expectTypeOf<CreateCredentialResult['updateId']>().toEqualTypeOf<UpdateId>();
    expectTypeOf<CreateCredentialResult['completionOffset']>().toEqualTypeOf<LedgerOffset>();
  });

  it('VerifyCredentialResult.verified is a plain boolean', () => {
    expectTypeOf<VerifyCredentialResult['verified']>().toEqualTypeOf<boolean>();
  });
});

describe('branded identifiers at runtime', () => {
  it('serialize as plain strings (no hidden brand field)', () => {
    // Branded types are runtime strings. We can't actually build one
    // without `asPartyIdUnchecked`, but we can verify the shape via
    // a cast and confirm JSON serialization is the bare string.
    const partyId = 'Operator::1220abcd' as PartyId;
    const contractId = '00deadbeef' as ContractId;
    expect(JSON.stringify({ partyId, contractId })).toBe(
      '{"partyId":"Operator::1220abcd","contractId":"00deadbeef"}',
    );
  });
});
