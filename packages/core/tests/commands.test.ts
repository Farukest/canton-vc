/**
 * Tests for `./src/commands`.
 *
 * `commands.ts` is pure: given a config + an input + an operator
 * party + a command id, it returns the exact JSON body the V2 API
 * expects. These tests pin:
 *
 *   * `newCommandId` — deterministic with injected clock + rand,
 *     rejects invalid clock values, enforces the max length.
 *   * `buildCreateCredentialCommand` — every field is validated,
 *     Daml-side enums are derived from DB-side input, outer body
 *     carries the correct `commands.commands` double wrapper, no
 *     `transactionFormat` (Bool return not needed).
 *   * `buildVerifyCredentialCommand` — exercise body, LEDGER_EFFECTS
 *     transactionFormat is present, choice = 'Verify'.
 *   * `buildRevokeCredentialCommand` — exercise body, no
 *     transactionFormat, choice = 'RevokeCredential'.
 *   * Validation errors: bad proof hash, bad validUntil shape, bad
 *     humanScore, bad contract id.
 */

import { describe, expect, it } from 'vitest';

import type { CommandId, CreateCredentialInput, PartyId } from '../src';
import {
  buildCreateCredentialCommand,
  buildRevokeCredentialCommand,
  buildVerifyCredentialCommand,
  CantonError,
  deterministicCommandId,
  isCantonErrorWithCode,
  MAX_COMMAND_ID_LENGTH,
  newCommandId,
  TRANSACTION_SHAPE_LEDGER_EFFECTS,
} from '../src';

import {
  buildTestConfig,
  FIXTURE_CONTRACT_ID,
  FIXTURE_NOW,
  FIXTURE_OPERATOR_PARTY,
  FIXTURE_USER_PARTY,
  fixtureClock,
  fixtureRand,
} from './fixtures';

const OPERATOR = FIXTURE_OPERATOR_PARTY as PartyId;
const USER = FIXTURE_USER_PARTY as PartyId;

const VALID_CREATE_INPUT: CreateCredentialInput = {
  userParty: USER,
  userRef: 'firm-user-fixture',
  proofHash: 'deadbeef',
  proofSchemaId: 'cafebabe1234567890abcdef',
  status: 'active',
  level: 'enhanced',
  validUntil: '2027-04-11T00:00:00Z',
  humanScore: 85,
  validator: 'didit',
  identityVerified: true,
  livenessVerified: true,
  addressVerified: false,
};

describe('newCommandId', () => {
  it('generates a deterministic command id from injected clock + rand', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(commandId).toBe(`crv-create-${FIXTURE_NOW.getTime()}-abababab`);
  });

  it('honours a custom prefix from config', () => {
    const config = buildTestConfig({ CANTON_COMMAND_ID_PREFIX: 'custom' });
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand);
    expect(commandId).toBe(`custom-verify-${FIXTURE_NOW.getTime()}-abababab`);
  });

  it('includes the purpose tag in the output', () => {
    const config = buildTestConfig();
    const create = newCommandId(config, 'create', fixtureClock, fixtureRand);
    const verify = newCommandId(config, 'verify', fixtureClock, fixtureRand);
    const revoke = newCommandId(config, 'revoke', fixtureClock, fixtureRand);
    expect(create).toContain('-create-');
    expect(verify).toContain('-verify-');
    expect(revoke).toContain('-revoke-');
  });

  it('uses Date.now and randomBytes by default', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create');
    expect(commandId.startsWith('crv-create-')).toBe(true);
    // Total length stays under the cap even in the default path.
    expect(commandId.length).toBeLessThanOrEqual(MAX_COMMAND_ID_LENGTH);
  });

  it('rejects a non-finite clock value', () => {
    const config = buildTestConfig();
    expect(() => newCommandId(config, 'create', () => Number.NaN, fixtureRand)).toThrow(
      CantonError,
    );
    expect(() =>
      newCommandId(config, 'create', () => Number.POSITIVE_INFINITY, fixtureRand),
    ).toThrow(CantonError);
  });

  it('rejects a negative clock value', () => {
    const config = buildTestConfig();
    expect(() => newCommandId(config, 'create', () => -1, fixtureRand)).toThrow(CantonError);
  });

  it('rejects a candidate longer than MAX_COMMAND_ID_LENGTH', () => {
    // Config caps CANTON_COMMAND_ID_PREFIX at 32 chars, so we force
    // overflow via the injected rand source: a 64-byte buffer becomes
    // 128 hex chars, which blows past the 64-char command id cap.
    const config = buildTestConfig({ CANTON_COMMAND_ID_PREFIX: 'x'.repeat(32) });
    const hugeRand = (_n: number): Buffer => Buffer.alloc(64, 0xcd);
    expect(() => newCommandId(config, 'create', fixtureClock, hugeRand)).toThrow(CantonError);
  });

  it('produces stable ordering when clock is stable', () => {
    const config = buildTestConfig();
    const a = newCommandId(config, 'create', fixtureClock, fixtureRand);
    const b = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(a).toBe(b);
  });
});

describe('deterministicCommandId', () => {
  it('produces the same id for the same seed', () => {
    const config = buildTestConfig();
    const seed = 'nft-mint:dce4d841-f3fb-4725-81c9-55512728b7ae';
    const a = deterministicCommandId(config, 'create-nft', seed);
    const b = deterministicCommandId(config, 'create-nft', seed);
    expect(a).toBe(b);
  });

  it('produces different ids for different seeds', () => {
    const config = buildTestConfig();
    const a = deterministicCommandId(config, 'create-nft', 'nft-mint:cred-A');
    const b = deterministicCommandId(config, 'create-nft', 'nft-mint:cred-B');
    expect(a).not.toBe(b);
  });

  it('embeds the purpose tag for participant log readability', () => {
    const config = buildTestConfig();
    const id = deterministicCommandId(config, 'create-nft', 'nft-mint:any');
    expect(id).toContain('-create-nft-');
  });

  it('rejects an empty seed', () => {
    const config = buildTestConfig();
    expect(() => deterministicCommandId(config, 'create-nft', '')).toThrow(CantonError);
  });

  it('stays under the command-id length cap', () => {
    const config = buildTestConfig({ CANTON_COMMAND_ID_PREFIX: 'crv' });
    const id = deterministicCommandId(config, 'create-nft', 'nft-mint:long-credential-id-uuid-with-extras');
    expect(id.length).toBeLessThanOrEqual(MAX_COMMAND_ID_LENGTH);
  });
});

describe('buildCreateCredentialCommand', () => {
  function build(): ReturnType<typeof buildCreateCredentialCommand> {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    return buildCreateCredentialCommand(config, VALID_CREATE_INPUT, OPERATOR, commandId);
  }

  it('wraps the inner list in the commands/commands double envelope', () => {
    const body = build();
    expect(body.commands.commands).toHaveLength(1);
    expect(body.commands.userId).toBe('canton-vc-test');
    expect(body.commands.actAs).toEqual([OPERATOR]);
    expect(body.commands.commandId).toContain('crv-create-');
  });

  it('emits a CreateCommand with the configured template id', () => {
    const body = build();
    const inner = body.commands.commands[0] as {
      CreateCommand: { templateId: string; createArguments: Record<string, unknown> };
    };
    expect(inner.CreateCommand.templateId).toBe('#canton-vc-credential:Canton.VC.Credential:Credential');
    expect(inner.CreateCommand.createArguments['operator']).toBe(OPERATOR);
    expect(inner.CreateCommand.createArguments['user']).toBe(USER);
  });

  it('converts DB-side enums to Daml-side enums in the payload', () => {
    const body = build();
    const args = (
      body.commands.commands[0] as {
        CreateCommand: { createArguments: Record<string, unknown> };
      }
    ).CreateCommand.createArguments;
    expect(args['status']).toBe('Active');
    expect(args['level']).toBe('Enhanced');
    expect(args['validator']).toBe('DiditValidator');
    expect(args['userRef']).toBe('firm-user-fixture');
  });

  it('passes through verification flags and human score', () => {
    const body = build();
    const args = (
      body.commands.commands[0] as {
        CreateCommand: { createArguments: Record<string, unknown> };
      }
    ).CreateCommand.createArguments;
    expect(args['identityVerified']).toBe(true);
    expect(args['livenessVerified']).toBe(true);
    expect(args['addressVerified']).toBe(false);
    expect(args['humanScore']).toBe(85);
    expect(args['network']).toBe('Canton MainNet');
    expect(args['validUntil']).toBe('2027-04-11T00:00:00Z');
  });

  it('does NOT include transactionFormat for create (unit return)', () => {
    const body = build();
    expect(body.transactionFormat).toBeUndefined();
  });

  it('lowercases uppercase hex proof hashes', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    const body = buildCreateCredentialCommand(
      config,
      { ...VALID_CREATE_INPUT, proofHash: 'DEADBEEF' },
      OPERATOR,
      commandId,
    );
    const args = (
      body.commands.commands[0] as {
        CreateCommand: { createArguments: Record<string, unknown> };
      }
    ).CreateCommand.createArguments;
    expect(args['proofHash']).toBe('deadbeef');
  });

  it('rejects an empty proof hash', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, proofHash: '' },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/proofHash/);
  });

  it('rejects a non-hex proof hash', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, proofHash: 'not-hex!' },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/hex/);
  });

  it('rejects a proof hash longer than 128 chars', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    const tooLong = 'a'.repeat(129);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, proofHash: tooLong },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/128/);
  });

  it('rejects a validUntil that is not ISO 8601 timestamp shape', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, validUntil: '2027-04-11' },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/validUntil/);
  });

  it('rejects a validUntil that does not round-trip (e.g. Feb 31)', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    try {
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, validUntil: '2027-02-31T00:00:00Z' },
        OPERATOR,
        commandId,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_command')).toBe(true);
      expect((err as CantonError).message).toMatch(/round-trip/);
    }
  });

  it('rejects a humanScore out of range', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, humanScore: 101 },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/humanScore/);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, humanScore: -1 },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/humanScore/);
  });

  it('rejects a fractional humanScore', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, humanScore: 42.5 },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/humanScore/);
  });

  it('accepts the bounds 0 and 100 for humanScore', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'create', fixtureClock, fixtureRand);
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, humanScore: 0 },
        OPERATOR,
        commandId,
      ),
    ).not.toThrow();
    expect(() =>
      buildCreateCredentialCommand(
        config,
        { ...VALID_CREATE_INPUT, humanScore: 100 },
        OPERATOR,
        commandId,
      ),
    ).not.toThrow();
  });
});

describe('buildVerifyCredentialCommand', () => {
  function build() {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand) as CommandId;
    return {
      config,
      commandId,
      body: buildVerifyCredentialCommand(
        config,
        { contractId: FIXTURE_CONTRACT_ID as never, fetcher: OPERATOR },
        OPERATOR,
        commandId,
      ),
    };
  }

  it('emits an ExerciseCommand with choice=Verify and the fetcher choice argument', () => {
    const { body } = build();
    const inner = body.commands.commands[0] as {
      ExerciseCommand: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: Record<string, unknown>;
      };
    };
    expect(inner.ExerciseCommand.choice).toBe('Verify');
    expect(inner.ExerciseCommand.templateId).toBe(
      '#canton-vc-credential:Canton.VC.Credential:Credential',
    );
    expect(inner.ExerciseCommand.contractId).toBe(FIXTURE_CONTRACT_ID);
    // choice takes `with fetcher : Party`
    expect(inner.ExerciseCommand.choiceArgument).toEqual({ fetcher: OPERATOR });
  });

  it('includes transactionFormat with LEDGER_EFFECTS shape', () => {
    const { body } = build();
    expect(body.transactionFormat).toBeDefined();
    expect(body.transactionFormat?.transactionShape).toBe(TRANSACTION_SHAPE_LEDGER_EFFECTS);
    expect(body.transactionFormat?.eventFormat.verbose).toBe(true);
    const cumulative = body.transactionFormat?.eventFormat.filtersForAnyParty.cumulative;
    expect(cumulative?.length).toBe(1);
    expect(cumulative?.[0]?.identifierFilter.WildcardFilter.value.includeCreatedEventBlob).toBe(
      false,
    );
  });

  it('wraps the command in the commands/commands envelope with actAs = fetcher', () => {
    const { body, commandId } = build();
    expect(body.commands.commandId).toBe(commandId);
    // flexible-controller pattern: actAs is the fetcher (the
    // choice controller), not the operator.
    expect(body.commands.actAs).toEqual([OPERATOR]);
  });

  it('omits disclosedContracts when no blob is supplied', () => {
    const { body } = build();
    expect(body.commands.disclosedContracts).toBeUndefined();
  });

  it('attaches disclosedContracts when a base64 blob is supplied', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand) as CommandId;
    const body = buildVerifyCredentialCommand(
      config,
      {
        contractId: FIXTURE_CONTRACT_ID as never,
        fetcher: OPERATOR,
        disclosedBlobBase64: 'AAECAwQ',
      },
      OPERATOR,
      commandId,
    );
    expect(body.commands.disclosedContracts).toEqual([
      {
        contractId: FIXTURE_CONTRACT_ID,
        templateId: '#canton-vc-credential:Canton.VC.Credential:Credential',
        // Canton's JSON Ledger v2 requires standard base64 (not base64url)
        // on DisclosedContract.createdEventBlob. The command builder
        // normalizes via normalizeToStandardBase64() before submit:
        // url-safe chars are converted back, and missing `=` padding
        // is re-added. The 5-byte input `AAECAwQ` (no padding) becomes
        // `AAECAwQ=` after normalisation.
        createdEventBlob: 'AAECAwQ=',
      },
    ]);
  });

  it('rejects an empty contract id', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand) as CommandId;
    expect(() =>
      buildVerifyCredentialCommand(
        config,
        { contractId: '' as never, fetcher: OPERATOR },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/contractId/);
  });

  it('rejects a non-string contract id', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand) as CommandId;
    expect(() =>
      buildVerifyCredentialCommand(
        config,
        { contractId: 42 as unknown as never, fetcher: OPERATOR },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/contractId/);
  });

  it('rejects a contract id longer than 8192 chars', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'verify', fixtureClock, fixtureRand) as CommandId;
    const huge = 'a'.repeat(8193);
    expect(() =>
      buildVerifyCredentialCommand(
        config,
        { contractId: huge as never, fetcher: OPERATOR },
        OPERATOR,
        commandId,
      ),
    ).toThrowError(/8192/);
  });
});

describe('buildRevokeCredentialCommand', () => {
  function build() {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'revoke', fixtureClock, fixtureRand) as CommandId;
    return {
      config,
      commandId,
      body: buildRevokeCredentialCommand(
        config,
        { contractId: FIXTURE_CONTRACT_ID as never },
        OPERATOR,
        commandId,
      ),
    };
  }

  it('emits an ExerciseCommand with choice=RevokeCredential', () => {
    const { body } = build();
    const inner = body.commands.commands[0] as {
      ExerciseCommand: { choice: string; contractId: string };
    };
    expect(inner.ExerciseCommand.choice).toBe('RevokeCredential');
    expect(inner.ExerciseCommand.contractId).toBe(FIXTURE_CONTRACT_ID);
  });

  it('does NOT include transactionFormat (unit return)', () => {
    const { body } = build();
    expect(body.transactionFormat).toBeUndefined();
  });

  it('rejects an empty contract id', () => {
    const config = buildTestConfig();
    const commandId = newCommandId(config, 'revoke', fixtureClock, fixtureRand) as CommandId;
    expect(() =>
      buildRevokeCredentialCommand(config, { contractId: '' as never }, OPERATOR, commandId),
    ).toThrowError(/contractId/);
  });
});
