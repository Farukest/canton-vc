/**
 * Tests for `./src/commands` — v2.0.0 (CIP #204 alignment).
 *
 * Pins:
 *   * `newCommandId` produces deterministic + bounded output.
 *   * `deterministicCommandId` reproduces the same id from the same seed.
 *   * `buildCreateCredentialCommand` emits the joint-signatory shape
 *     (actAs = [issuer, holder]) with the #204 storage payload.
 *   * `buildVerifyCredentialCommand` exercises `Credential_PublicFetch`
 *     with `expectedAdmin` + `actor` choice arguments.
 *   * `buildRevokeCredentialCommand` exercises `RevokeCredential` with
 *     a required `reason` string.
 *   * Disclosed-contract base64url → base64 normalisation works.
 */

import { describe, expect, it } from 'vitest';
import type {
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateKycNftInput,
  PartyId,
  RevokeCredentialInput,
  VerifyCredentialInput,
} from '../src';
import {
  buildCreateCredentialCommand,
  buildCreateKycNftCommand,
  buildRevokeCredentialCommand,
  buildVerifyCredentialCommand,
  CantonError,
  deterministicCommandId,
  MAX_COMMAND_ID_LENGTH,
  newCommandId,
} from '../src';
import {
  buildClaims,
  buildTestConfig,
  FIXTURE_ADMIN_PARTY,
  FIXTURE_CLAIM_NS,
  FIXTURE_CONTRACT_ID,
  FIXTURE_HOLDER_PARTY,
  FIXTURE_ISSUER_PARTY,
  fixtureClock,
  fixtureRand,
} from './fixtures';

const TEST_CONFIG = buildTestConfig();

describe('newCommandId', () => {
  it('produces a deterministic id under a fixed clock + rand', () => {
    const id = newCommandId(TEST_CONFIG, 'create', fixtureClock, fixtureRand);
    expect(id).toMatch(/^crv-create-\d+-[0-9a-f]{8}$/);
    expect(id.length).toBeLessThanOrEqual(MAX_COMMAND_ID_LENGTH);
  });

  it('uses the configured prefix and supplied purpose', () => {
    const id = newCommandId(TEST_CONFIG, 'verify', fixtureClock, fixtureRand);
    expect(id.startsWith('crv-verify-')).toBe(true);
  });

  it('throws on a non-finite clock', () => {
    expect(() => newCommandId(TEST_CONFIG, 'create', () => Number.NaN, fixtureRand)).toThrow(
      CantonError,
    );
  });
});

describe('deterministicCommandId', () => {
  it('produces the same id for the same seed', () => {
    const a = deterministicCommandId(TEST_CONFIG, 'create-nft', 'credential-uuid-x');
    const b = deterministicCommandId(TEST_CONFIG, 'create-nft', 'credential-uuid-x');
    expect(a).toBe(b);
  });

  it('produces distinct ids for distinct seeds', () => {
    const a = deterministicCommandId(TEST_CONFIG, 'create-nft', 'credential-uuid-x');
    const b = deterministicCommandId(TEST_CONFIG, 'create-nft', 'credential-uuid-y');
    expect(a).not.toBe(b);
  });

  it('rejects an empty seed', () => {
    expect(() => deterministicCommandId(TEST_CONFIG, 'create-nft', '')).toThrow(CantonError);
  });
});

const SAMPLE_CREATE_INPUT: CreateCredentialInput = {
  issuerParty: FIXTURE_ISSUER_PARTY as PartyId,
  holderParty: FIXTURE_HOLDER_PARTY as PartyId,
  adminParty: FIXTURE_ADMIN_PARTY as PartyId,
  claims: buildClaims(),
  createdAt: '2026-04-11T18:00:00Z',
  expiresAt: '2027-04-11T18:00:00Z',
  meta: { 'com.example/note': 'fixture' },
};

describe('buildCreateCredentialCommand', () => {
  it('emits actAs containing both issuer and holder (joint signatory)', () => {
    const commandId = 'crv-create-fixed' as CommandId;
    const body = buildCreateCredentialCommand(TEST_CONFIG, SAMPLE_CREATE_INPUT, commandId);
    expect(body.commands.actAs).toEqual([FIXTURE_ISSUER_PARTY, FIXTURE_HOLDER_PARTY]);
  });

  it('emits a CreateCommand wrapping the #204 storage shape', () => {
    const commandId = 'crv-create-fixed' as CommandId;
    const body = buildCreateCredentialCommand(TEST_CONFIG, SAMPLE_CREATE_INPUT, commandId);
    const inner = body.commands.commands[0] as { CreateCommand: { createArguments: unknown } };
    const args = inner.CreateCommand.createArguments as {
      issuer: string;
      holder: string;
      admin: string;
      claims: { values: Record<string, string>; validFrom: string | null; validUntil: string | null };
      createdAt: string | null;
      expiresAt: string | null;
      meta: Record<string, string>;
    };
    expect(args.issuer).toBe(FIXTURE_ISSUER_PARTY);
    expect(args.holder).toBe(FIXTURE_HOLDER_PARTY);
    expect(args.admin).toBe(FIXTURE_ADMIN_PARTY);
    expect(args.claims.values[`${FIXTURE_CLAIM_NS}/level`]).toBe('Enhanced');
    expect(args.createdAt).toBe('2026-04-11T18:00:00Z');
    expect(args.expiresAt).toBe('2027-04-11T18:00:00Z');
  });

  it('rejects an empty claims map (template ensure clause invariant)', () => {
    const input: CreateCredentialInput = {
      ...SAMPLE_CREATE_INPUT,
      claims: { values: {}, validFrom: null, validUntil: null, meta: {} },
    };
    expect(() =>
      buildCreateCredentialCommand(TEST_CONFIG, input, 'crv-create-x' as CommandId),
    ).toThrow(CantonError);
  });

  it('rejects an invalid ISO timestamp for claims.validUntil', () => {
    const input: CreateCredentialInput = {
      ...SAMPLE_CREATE_INPUT,
      claims: { ...SAMPLE_CREATE_INPUT.claims, validUntil: 'not-a-time' },
    };
    expect(() =>
      buildCreateCredentialCommand(TEST_CONFIG, input, 'crv-create-x' as CommandId),
    ).toThrow(CantonError);
  });

  it('rejects an empty issuer party', () => {
    const input: CreateCredentialInput = { ...SAMPLE_CREATE_INPUT, issuerParty: '' as PartyId };
    expect(() =>
      buildCreateCredentialCommand(TEST_CONFIG, input, 'crv-create-x' as CommandId),
    ).toThrow(CantonError);
  });
});

const SAMPLE_VERIFY_INPUT: VerifyCredentialInput = {
  contractId: FIXTURE_CONTRACT_ID as ContractId,
  actor: FIXTURE_HOLDER_PARTY as PartyId,
  expectedAdmin: FIXTURE_ADMIN_PARTY as PartyId,
};

describe('buildVerifyCredentialCommand', () => {
  it('emits actAs containing only the actor (choice controller)', () => {
    const body = buildVerifyCredentialCommand(
      TEST_CONFIG,
      SAMPLE_VERIFY_INPUT,
      'crv-verify-x' as CommandId,
    );
    expect(body.commands.actAs).toEqual([FIXTURE_HOLDER_PARTY]);
  });

  it('exercises the Credential_PublicFetch choice with expectedAdmin + actor', () => {
    const body = buildVerifyCredentialCommand(
      TEST_CONFIG,
      SAMPLE_VERIFY_INPUT,
      'crv-verify-x' as CommandId,
    );
    const inner = body.commands.commands[0] as {
      ExerciseCommand: {
        choice: string;
        choiceArgument: { expectedAdmin: string; actor: string };
      };
    };
    expect(inner.ExerciseCommand.choice).toBe('Credential_PublicFetch');
    expect(inner.ExerciseCommand.choiceArgument.expectedAdmin).toBe(FIXTURE_ADMIN_PARTY);
    expect(inner.ExerciseCommand.choiceArgument.actor).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('does NOT include disclosedContracts when blob is absent', () => {
    const body = buildVerifyCredentialCommand(
      TEST_CONFIG,
      SAMPLE_VERIFY_INPUT,
      'crv-verify-x' as CommandId,
    );
    expect(body.commands.disclosedContracts).toBeUndefined();
  });

  it('attaches disclosedContracts when blob is supplied + uses resolved template id', () => {
    const body = buildVerifyCredentialCommand(
      TEST_CONFIG,
      { ...SAMPLE_VERIFY_INPUT, disclosedBlobBase64: 'YWJjZGVm' },
      'crv-verify-x' as CommandId,
      'a-resolved-template-hash:Canton.VC.Credential:Credential',
    );
    expect(body.commands.disclosedContracts).toHaveLength(1);
    const dc = body.commands.disclosedContracts?.[0];
    expect(dc?.templateId).toBe('a-resolved-template-hash:Canton.VC.Credential:Credential');
  });

  it('normalises base64url disclosed blob to standard base64', () => {
    const blob = 'A-B_Cd';
    const body = buildVerifyCredentialCommand(
      TEST_CONFIG,
      { ...SAMPLE_VERIFY_INPUT, disclosedBlobBase64: blob },
      'crv-verify-x' as CommandId,
      'a-resolved-template-hash:Canton.VC.Credential:Credential',
    );
    const dc = body.commands.disclosedContracts?.[0];
    expect(dc?.createdEventBlob).toBe('A+B/Cd==');
  });
});

const SAMPLE_REVOKE_INPUT: RevokeCredentialInput = {
  contractId: FIXTURE_CONTRACT_ID as ContractId,
  reason: 'compliance-policy-violation',
};

describe('buildRevokeCredentialCommand', () => {
  it('emits actAs containing only the issuer (choice controller)', () => {
    const body = buildRevokeCredentialCommand(
      TEST_CONFIG,
      SAMPLE_REVOKE_INPUT,
      FIXTURE_ISSUER_PARTY as PartyId,
      'crv-revoke-x' as CommandId,
    );
    expect(body.commands.actAs).toEqual([FIXTURE_ISSUER_PARTY]);
  });

  it('exercises RevokeCredential with reason + null nftCid by default', () => {
    const body = buildRevokeCredentialCommand(
      TEST_CONFIG,
      SAMPLE_REVOKE_INPUT,
      FIXTURE_ISSUER_PARTY as PartyId,
      'crv-revoke-x' as CommandId,
    );
    const inner = body.commands.commands[0] as {
      ExerciseCommand: { choice: string; choiceArgument: { nftCid: unknown; reason: string } };
    };
    expect(inner.ExerciseCommand.choice).toBe('RevokeCredential');
    expect(inner.ExerciseCommand.choiceArgument.nftCid).toBe(null);
    expect(inner.ExerciseCommand.choiceArgument.reason).toBe('compliance-policy-violation');
  });

  it('passes nftCid when supplied', () => {
    const body = buildRevokeCredentialCommand(
      TEST_CONFIG,
      { ...SAMPLE_REVOKE_INPUT, nftContractId: 'nft-cid' as ContractId },
      FIXTURE_ISSUER_PARTY as PartyId,
      'crv-revoke-x' as CommandId,
    );
    const inner = body.commands.commands[0] as {
      ExerciseCommand: { choiceArgument: { nftCid: string } };
    };
    expect(inner.ExerciseCommand.choiceArgument.nftCid).toBe('nft-cid');
  });

  it('rejects an empty reason', () => {
    expect(() =>
      buildRevokeCredentialCommand(
        TEST_CONFIG,
        { ...SAMPLE_REVOKE_INPUT, reason: '' },
        FIXTURE_ISSUER_PARTY as PartyId,
        'crv-revoke-x' as CommandId,
      ),
    ).toThrow(CantonError);
  });
});

const SAMPLE_NFT_INPUT: CreateKycNftInput = {
  holderParty: FIXTURE_HOLDER_PARTY as PartyId,
  boundCredentialId: FIXTURE_CONTRACT_ID as ContractId,
  level: 'Enhanced',
  serialNumber: 'SN-0001',
  displayName: 'Demo Holder',
  image: 'data:image/svg+xml;base64,YWJjZGVm',
};

describe('buildCreateKycNftCommand', () => {
  it('emits a CreateCommand on the KycNFT template id', () => {
    const body = buildCreateKycNftCommand(
      TEST_CONFIG,
      SAMPLE_NFT_INPUT,
      FIXTURE_ISSUER_PARTY as PartyId,
      'crv-create-nft-x' as CommandId,
    );
    const inner = body.commands.commands[0] as {
      CreateCommand: { templateId: string; createArguments: { level: string } };
    };
    expect(inner.CreateCommand.templateId).toContain(':KycNFT');
    expect(inner.CreateCommand.createArguments.level).toBe('Enhanced');
  });

  it('rejects an empty serial number', () => {
    expect(() =>
      buildCreateKycNftCommand(
        TEST_CONFIG,
        { ...SAMPLE_NFT_INPUT, serialNumber: '' },
        FIXTURE_ISSUER_PARTY as PartyId,
        'crv-create-nft-x' as CommandId,
      ),
    ).toThrow(CantonError);
  });
});
