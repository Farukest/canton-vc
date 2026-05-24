/**
 * Tests for `./src/ledger`.
 *
 * `ledger.ts` is the semantic write layer. These tests stub the
 * transport with `buildFakeFetch()` and drive:
 *
 *   * `resolveNamespace` — fetches participant id, caches, no double call.
 *   * `partyExists` — 200 with non-empty list → true, 200 empty → false,
 *     404 → false (swallowed), other errors propagate.
 *   * `allocateParty` — POST body shape, happy path, rejection branches.
 *   * `getLedgerEnd` — shape + return.
 *   * `createCredential` — POSTs to submit-and-wait, parses CreatedEvent,
 *     extracts contract id, returns full result.
 *   * `verifyCredential` — exercises Verify, extracts boolean result,
 *     tolerates 'true'/'false' strings, errors on non-boolean.
 *   * `revokeCredential` — exercises RevokeCredential, returns metadata.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateCredentialInput, PartyId, VerifyCredentialInput } from '../src';
import {
  allocateParty,
  CantonError,
  createCredential,
  getLedgerEnd,
  isCantonErrorWithCode,
  partyExists,
  resetAllNamespaceCachesForTests,
  resolveNamespace,
  revokeCredential,
  verifyCredential,
} from '../src';

import {
  buildCreateSubmitResponse,
  buildFakeFetch,
  buildRevokeSubmitResponse,
  buildTestConfig,
  buildVerifySubmitResponse,
  FIXTURE_CONTRACT_ID,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_NAMESPACE,
  FIXTURE_OPERATOR_PARTY,
  FIXTURE_PARTICIPANT_ID,
  FIXTURE_RECORD_TIME,
  FIXTURE_UPDATE_ID,
  FIXTURE_USER_PARTY,
} from './fixtures';

const VALID_CREATE_INPUT: CreateCredentialInput = {
  userParty: FIXTURE_USER_PARTY as PartyId,
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

beforeEach(() => {
  resetAllNamespaceCachesForTests();
});
afterEach(() => {
  resetAllNamespaceCachesForTests();
});

describe('resolveNamespace', () => {
  it('fetches /v2/parties/participant-id and returns the fingerprint', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: FIXTURE_PARTICIPANT_ID } });
    const ns = await resolveNamespace(config, fake.fetch);
    expect(ns).toBe(FIXTURE_NAMESPACE);
    expect(fake.captured[0]?.path).toBe('/v2/parties/participant-id');
    expect(fake.captured[0]?.method).toBe('GET');
  });

  it('caches the result across calls (single fetch)', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: FIXTURE_PARTICIPANT_ID } });
    await resolveNamespace(config, fake.fetch);
    await resolveNamespace(config, fake.fetch);
    await resolveNamespace(config, fake.fetch);
    expect(fake.captured).toHaveLength(1);
  });

  it('throws when the participant id is malformed (propagates parsePartyId)', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: 'garbage' } });
    try {
      await resolveNamespace(config, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CantonError);
      // `participantIdToNamespace` delegates to `parsePartyId`, so a
      // participant id missing the `::` separator surfaces as
      // `invalid_party` rather than a dedicated namespace code.
      expect((err as CantonError).code).toBe('invalid_party');
    }
  });
});

describe('partyExists', () => {
  it('returns true when partyDetails is non-empty', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: { partyDetails: [{ party: FIXTURE_USER_PARTY, isLocal: true }] },
    });
    const result = await partyExists(config, FIXTURE_USER_PARTY as PartyId, fake.fetch);
    expect(result).toBe(true);
  });

  it('returns false when partyDetails is empty', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { partyDetails: [] } });
    const result = await partyExists(config, FIXTURE_USER_PARTY as PartyId, fake.fetch);
    expect(result).toBe(false);
  });

  it('returns false on a 404 response', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 404, body: { cause: 'unknown' } });
    const result = await partyExists(config, FIXTURE_USER_PARTY as PartyId, fake.fetch);
    expect(result).toBe(false);
  });

  it('URL-encodes the party id (the :: must not break the path)', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { partyDetails: [] } });
    await partyExists(config, FIXTURE_USER_PARTY as PartyId, fake.fetch);
    expect(fake.captured[0]?.path).toContain('%3A%3A');
  });

  it('propagates non-404 errors', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 401, body: { cause: 'no' } });
    try {
      await partyExists(config, FIXTURE_USER_PARTY as PartyId, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('unauthorized');
    }
  });
});

describe('allocateParty', () => {
  it('POSTs to /v2/parties with the label hint', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: { partyDetails: { party: FIXTURE_USER_PARTY, isLocal: true } },
    });
    const pid = await allocateParty(config, 'User-abc123', fake.fetch);
    expect(pid).toBe(FIXTURE_USER_PARTY);
    expect(fake.captured[0]?.method).toBe('POST');
    expect(fake.captured[0]?.path).toBe('/v2/parties');
    expect(fake.captured[0]?.body).toEqual({ partyIdHint: 'User-abc123' });
  });

  it('rejects an empty label hint', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    try {
      await allocateParty(config, '', fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_party')).toBe(true);
    }
    expect(fake.captured).toHaveLength(0);
  });

  it('rejects an empty party string returned from the participant', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: { partyDetails: { party: 'bogus', isLocal: true } },
    });
    try {
      await allocateParty(config, 'bogus', fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      // parsePartyId throws invalid_party because 'bogus' has no ::.
      expect(isCantonErrorWithCode(err, 'invalid_party')).toBe(true);
    }
  });
});

describe('getLedgerEnd', () => {
  it('GETs /v2/state/ledger-end and returns the offset', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    const offset = await getLedgerEnd(config, fake.fetch);
    expect(offset).toBe(FIXTURE_LEDGER_OFFSET);
    expect(fake.captured[0]?.method).toBe('GET');
    expect(fake.captured[0]?.path).toBe('/v2/state/ledger-end');
  });
});

describe('createCredential', () => {
  it('POSTs a submit-and-wait command and returns the contract id', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildCreateSubmitResponse() });
    const result = await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(result.updateId).toBe(FIXTURE_UPDATE_ID);
    expect(result.recordTime).toBe(FIXTURE_RECORD_TIME);
    expect(result.completionOffset).toBe(FIXTURE_LEDGER_OFFSET);
    expect(result.commandId).toMatch(/^crv-create-/);
  });

  it('uses the submit-and-wait-for-transaction endpoint', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildCreateSubmitResponse() });
    await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
    expect(fake.captured[0]?.path).toBe('/v2/commands/submit-and-wait-for-transaction');
    expect(fake.captured[0]?.method).toBe('POST');
  });

  it('sends a body with the commands/commands double envelope', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildCreateSubmitResponse() });
    await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
    const body = fake.captured[0]?.body as {
      commands: { actAs: string[]; commands: Array<{ CreateCommand: { templateId: string } }> };
    };
    expect(body.commands.actAs).toEqual([FIXTURE_OPERATOR_PARTY]);
    expect(body.commands.commands).toHaveLength(1);
    expect(body.commands.commands[0]?.CreateCommand.templateId).toBe(
      '#canton-vc-credential:Canton.VC.Credential:Credential',
    );
  });

  it('does not retry a 500 on a create POST', async () => {
    const config = buildTestConfig({ CANTON_MAX_RETRIES: '3', CANTON_RETRY_BASE_DELAY_MS: '0' });
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', status: 500, body: { cause: 'oops' } });
    try {
      await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('service_unavailable');
    }
    expect(fake.captured).toHaveLength(1);
  });

  it('throws submit_failed when the response lacks a CreatedEvent', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: {
        transaction: {
          updateId: FIXTURE_UPDATE_ID,
          recordTime: FIXTURE_RECORD_TIME,
          offset: FIXTURE_LEDGER_OFFSET,
          events: [],
        },
      },
    });
    try {
      await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('submit_failed');
      expect((err as CantonError).message).toMatch(/no CreatedEvent/);
    }
  });

  it('maps a 422 on submit to submit_failed', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      status: 422,
      body: { cause: 'contention on template', code: 'CONTRACT_NOT_FOUND' },
    });
    try {
      await createCredential(config, VALID_CREATE_INPUT, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('submit_failed');
    }
  });
});

describe('verifyCredential', () => {
  const VERIFY_INPUT: VerifyCredentialInput = {
    contractId: FIXTURE_CONTRACT_ID as never,
    fetcher: FIXTURE_OPERATOR_PARTY as never,
  };

  it('returns verified=true for a boolean-true exercise result', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildVerifySubmitResponse(true) });
    const result = await verifyCredential(config, VERIFY_INPUT, fake.fetch);
    expect(result.verified).toBe(true);
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(result.commandId).toMatch(/^crv-verify-/);
  });

  it('returns verified=false for a boolean-false exercise result', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildVerifySubmitResponse(false) });
    const result = await verifyCredential(config, VERIFY_INPUT, fake.fetch);
    expect(result.verified).toBe(false);
  });

  it('sends a body with choice=Verify', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildVerifySubmitResponse(true) });
    await verifyCredential(config, VERIFY_INPUT, fake.fetch);
    const body = fake.captured[0]?.body as {
      commands: {
        commands: Array<{ ExerciseCommand: { choice: string; contractId: string } }>;
      };
      transactionFormat?: { transactionShape: string };
    };
    expect(body.commands.commands[0]?.ExerciseCommand.choice).toBe('Verify');
    expect(body.commands.commands[0]?.ExerciseCommand.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(body.transactionFormat?.transactionShape).toBe('TRANSACTION_SHAPE_LEDGER_EFFECTS');
  });

  it('throws invalid_response when the exercise result does not match CredentialView', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    // Replace the struct view with a primitive — expects a
    // record matching `CredentialView`; a number fails the schema
    // parse and surfaces as `invalid_response`.
    const body = buildVerifySubmitResponse(true, { exerciseResult: 42 });
    fake.enqueue({ kind: 'json', body });
    try {
      await verifyCredential(config, VERIFY_INPUT, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('invalid_response');
      expect((err as CantonError).message).toMatch(/CredentialView/);
    }
  });

  it('throws invalid_response when no ExercisedEvent is present', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: {
        transaction: {
          updateId: FIXTURE_UPDATE_ID,
          recordTime: FIXTURE_RECORD_TIME,
          offset: FIXTURE_LEDGER_OFFSET,
          events: [],
        },
      },
    });
    try {
      await verifyCredential(config, VERIFY_INPUT, fake.fetch);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('invalid_response');
      expect((err as CantonError).message).toMatch(/no ExercisedEvent/);
    }
  });
});

describe('revokeCredential', () => {
  it('POSTs an exercise with choice=RevokeCredential and returns metadata', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildRevokeSubmitResponse() });
    const result = await revokeCredential(
      config,
      { contractId: FIXTURE_CONTRACT_ID as never },
      fake.fetch,
    );
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(result.updateId).toBe(FIXTURE_UPDATE_ID);
    expect(result.recordTime).toBe(FIXTURE_RECORD_TIME);
    expect(result.commandId).toMatch(/^crv-revoke-/);
    const body = fake.captured[0]?.body as {
      commands: { commands: Array<{ ExerciseCommand: { choice: string } }> };
    };
    expect(body.commands.commands[0]?.ExerciseCommand.choice).toBe('RevokeCredential');
  });
});
