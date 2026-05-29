/**
 * Tests for `./src/client` — v2.0.0 (CIP #204 alignment).
 *
 * `CantonClient` is a thin facade. These tests verify each method
 * delegates to the underlying pure function with the supplied
 * `fetchImpl` and `clock`.
 */

import { describe, expect, it } from 'vitest';
import type { ContractId, PartyId } from '../src';
import { CantonClient } from '../src';
import {
  buildAcsEntry,
  buildClaims,
  buildFakeFetch,
  buildPublicFetchSubmitResponse,
  buildRevokeSubmitResponse,
  buildTestConfig,
  FIXTURE_ADMIN_PARTY,
  FIXTURE_CONTRACT_ID,
  FIXTURE_HOLDER_PARTY,
  FIXTURE_ISSUER_PARTY,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_NOW,
} from './fixtures';

const TEST_CONFIG = buildTestConfig();

describe('CantonClient', () => {
  it('exposes the supplied config on the instance', () => {
    const client = new CantonClient({ config: TEST_CONFIG });
    expect(client.config).toBe(TEST_CONFIG);
  });

  it('delegates verifyCredential to the underlying transport', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildPublicFetchSubmitResponse() });
    const client = new CantonClient({ config: TEST_CONFIG, fetchImpl: fake.fetch });
    const result = await client.verifyCredential({
      contractId: FIXTURE_CONTRACT_ID as ContractId,
      actor: FIXTURE_HOLDER_PARTY as PartyId,
      expectedAdmin: FIXTURE_ADMIN_PARTY as PartyId,
    });
    expect(result.view.holder).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('delegates revokeCredential, threading the issuerParty argument', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildRevokeSubmitResponse() });
    const client = new CantonClient({ config: TEST_CONFIG, fetchImpl: fake.fetch });
    const result = await client.revokeCredential(
      { contractId: FIXTURE_CONTRACT_ID as ContractId, reason: 'compliance' },
      FIXTURE_ISSUER_PARTY as PartyId,
    );
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    const body = fake.captured[0]?.body as { commands: { actAs: string[] } };
    expect(body.commands.actAs).toEqual([FIXTURE_ISSUER_PARTY]);
  });

  it('delegates findActiveCredentialByHolder against the holder party', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry()] });
    const client = new CantonClient({ config: TEST_CONFIG, fetchImpl: fake.fetch });
    const contract = await client.findActiveCredentialByHolder(
      FIXTURE_HOLDER_PARTY as PartyId,
    );
    expect(contract?.payload.holder).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('uses the supplied clock for fetchDisclosureBundleByHolder.fetchedAt', async () => {
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry({ createdEventBlob: 'YWJjZGVm' })] });
    const client = new CantonClient({
      config: TEST_CONFIG,
      fetchImpl: fake.fetch,
      clock: () => FIXTURE_NOW,
    });
    const bundle = await client.fetchDisclosureBundleByHolder(FIXTURE_HOLDER_PARTY as PartyId);
    expect(bundle?.fetchedAt).toEqual(FIXTURE_NOW);
  });

  it('exposes resetNamespaceCacheForTests', () => {
    const client = new CantonClient({ config: TEST_CONFIG });
    expect(typeof client.resetNamespaceCacheForTests).toBe('function');
    // Should be idempotent.
    client.resetNamespaceCacheForTests();
    client.resetNamespaceCacheForTests();
  });

  it('uses buildClaims fixture in CreateCredentialInput shape', () => {
    // Compile-time only: ensure CreateCredentialInput accepts the
    // fixture-generated claims map.
    const claims = buildClaims();
    expect(claims.values).toBeDefined();
  });
});
