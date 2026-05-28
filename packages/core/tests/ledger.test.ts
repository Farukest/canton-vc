/**
 * Tests for `./src/ledger` — v2.0.0 (CIP #204 alignment).
 *
 * Pins the high-level write ops:
 *
 *   * `createCredential` posts the joint-signatory submit body,
 *     parses the CreatedEvent, returns the contract id + audit
 *     metadata.
 *   * `verifyCredential` exercises `Credential_PublicFetch` and
 *     returns the parsed `CredentialView`.
 *   * `revokeCredential` exercises `RevokeCredential` with a
 *     non-empty reason and the supplied issuer party as `actAs`.
 *   * `resolveNamespace` round-trips through the participant cache.
 */

import { describe, expect, it } from 'vitest';

import { createCredential, resolveNamespace, revokeCredential, verifyCredential } from '../src';
import type {
  ContractId,
  CreateCredentialInput,
  PartyId,
  RevokeCredentialInput,
  VerifyCredentialInput,
} from '../src';
import { resetAllNamespaceCachesForTests } from '../src';
import {
  buildClaims,
  buildCreateSubmitResponse,
  buildFakeFetch,
  buildPublicFetchSubmitResponse,
  buildRevokeSubmitResponse,
  buildTestConfig,
  FIXTURE_ADMIN_PARTY,
  FIXTURE_CONTRACT_ID,
  FIXTURE_HOLDER_PARTY,
  FIXTURE_ISSUER_PARTY,
  FIXTURE_PARTICIPANT_ID,
} from './fixtures';

const TEST_CONFIG = buildTestConfig();

const SAMPLE_CREATE_INPUT: CreateCredentialInput = {
  issuerParty: FIXTURE_ISSUER_PARTY as PartyId,
  holderParty: FIXTURE_HOLDER_PARTY as PartyId,
  adminParty: FIXTURE_ADMIN_PARTY as PartyId,
  claims: buildClaims(),
  createdAt: '2026-04-11T18:00:00Z',
  expiresAt: '2027-04-11T18:00:00Z',
};

const SAMPLE_VERIFY_INPUT: VerifyCredentialInput = {
  contractId: FIXTURE_CONTRACT_ID as ContractId,
  actor: FIXTURE_HOLDER_PARTY as PartyId,
  expectedAdmin: FIXTURE_ADMIN_PARTY as PartyId,
};

const SAMPLE_REVOKE_INPUT: RevokeCredentialInput = {
  contractId: FIXTURE_CONTRACT_ID as ContractId,
  reason: 'compliance-policy',
};

describe('resolveNamespace', () => {
  it('fetches the participant id and caches the namespace fingerprint', async () => {
    resetAllNamespaceCachesForTests();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: FIXTURE_PARTICIPANT_ID } });
    const ns = await resolveNamespace(TEST_CONFIG, fake.fetch);
    expect(ns.length).toBeGreaterThan(0);
    // Second call hits the cache — no fetch.
    fake.reset();
    const ns2 = await resolveNamespace(TEST_CONFIG, fake.fetch);
    expect(ns2).toBe(ns);
    expect(fake.captured).toHaveLength(0);
  });
});

describe('createCredential', () => {
  it('posts submit-and-wait and returns the new contract id', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildCreateSubmitResponse() });
    const result = await createCredential(TEST_CONFIG, SAMPLE_CREATE_INPUT, fake.fetch);
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(fake.captured).toHaveLength(1);
    const req = fake.captured[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/v2/commands/submit-and-wait-for-transaction');
    const body = req?.body as { commands: { actAs: string[] } };
    expect(body.commands.actAs).toEqual([FIXTURE_ISSUER_PARTY, FIXTURE_HOLDER_PARTY]);
  });
});

describe('verifyCredential', () => {
  it('exercises Credential_PublicFetch and returns the parsed view', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildPublicFetchSubmitResponse() });
    const result = await verifyCredential(TEST_CONFIG, SAMPLE_VERIFY_INPUT, fake.fetch);
    expect(result.view.admin).toBe(FIXTURE_ADMIN_PARTY);
    expect(result.view.issuer).toBe(FIXTURE_ISSUER_PARTY);
    expect(result.view.holder).toBe(FIXTURE_HOLDER_PARTY);
    expect(fake.captured).toHaveLength(1);
    const body = fake.captured[0]?.body as {
      commands: {
        actAs: string[];
        commands: Array<{ ExerciseCommand: { choice: string } }>;
      };
    };
    expect(body.commands.actAs).toEqual([FIXTURE_HOLDER_PARTY]);
    expect(body.commands.commands[0]?.ExerciseCommand.choice).toBe('Credential_PublicFetch');
  });
});

describe('revokeCredential', () => {
  it('posts the RevokeCredential exercise with the supplied issuer party as actAs', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildRevokeSubmitResponse() });
    const result = await revokeCredential(
      TEST_CONFIG,
      SAMPLE_REVOKE_INPUT,
      FIXTURE_ISSUER_PARTY as PartyId,
      fake.fetch,
    );
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(fake.captured).toHaveLength(1);
    const body = fake.captured[0]?.body as { commands: { actAs: string[] } };
    expect(body.commands.actAs).toEqual([FIXTURE_ISSUER_PARTY]);
  });
});
