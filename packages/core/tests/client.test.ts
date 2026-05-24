/**
 * Tests for `./src/client`.
 *
 * `CantonClient` is a thin facade that bundles a `CantonConfig`, an
 * optional `FetchLike`, and a clock. These tests exercise:
 *
 *   * Construction: stored config, default clock, cached namespace
 *     starts null.
 *   * Each bundled method forwards the injected fetch/clock to the
 *     underlying pure function (asserted via `buildFakeFetch`).
 *   * `getCantonClient()` singleton returns the same instance and
 *     rebuilds after `resetCantonClientForTests()`.
 *   * `buildCantonClientFromEnv()` constructs a standalone client
 *     without touching the process cache.
 *   * `resetNamespaceCacheForTests()` on an instance drops only
 *     that config's cache entry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContractId, PartyId } from '../src';
import {
  buildCantonClientFromEnv,
  CantonClient,
  CantonError,
  getCantonClient,
  resetAllNamespaceCachesForTests,
  resetCantonClientForTests,
  resetCantonConfigForTests,
} from '../src';

import {
  buildAcsEntry,
  buildCreateSubmitResponse,
  buildFakeFetch,
  buildRevokeSubmitResponse,
  buildTestConfig,
  buildVerifySubmitResponse,
  FIXTURE_CONTRACT_ID,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_NAMESPACE,
  FIXTURE_NOW,
  FIXTURE_OPERATOR_PARTY,
  FIXTURE_PARTICIPANT_ID,
  FIXTURE_USER_PARTY,
} from './fixtures';

beforeEach(() => {
  resetAllNamespaceCachesForTests();
  resetCantonClientForTests();
  resetCantonConfigForTests();
});
afterEach(() => {
  resetAllNamespaceCachesForTests();
  resetCantonClientForTests();
  resetCantonConfigForTests();
  delete process.env['CANTON_JSON_API_BASE_URL'];
  delete process.env['CANTON_OPERATOR_PARTY'];
});

describe('CantonClient — construction', () => {
  it('stores the config on the instance', () => {
    const config = buildTestConfig();
    const client = new CantonClient({ config });
    expect(client.config).toBe(config);
  });

  it('cachedNamespace starts null', () => {
    const config = buildTestConfig();
    const client = new CantonClient({ config });
    expect(client.cachedNamespace()).toBeNull();
  });

  it('uses a default clock when none supplied', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry({ createdEventBlob: 'YWJj' })] });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const bundle = await client.fetchDisclosureBundleByUser(FIXTURE_USER_PARTY as PartyId);
    expect(bundle?.fetchedAt).toBeInstanceOf(Date);
  });

  it('uses an injected clock when supplied', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry({ createdEventBlob: 'YWJj' })] });
    const client = new CantonClient({
      config,
      fetchImpl: fake.fetch,
      clock: () => FIXTURE_NOW,
    });
    const bundle = await client.fetchDisclosureBundleByUser(FIXTURE_USER_PARTY as PartyId);
    expect(bundle?.fetchedAt).toEqual(FIXTURE_NOW);
  });
});

describe('CantonClient — bootstrap methods', () => {
  it('resolveNamespace fetches the participant id and caches it', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: FIXTURE_PARTICIPANT_ID } });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const ns = await client.resolveNamespace();
    expect(ns).toBe(FIXTURE_NAMESPACE);
    expect(client.cachedNamespace()).toBe(FIXTURE_NAMESPACE);
  });

  it('partyExists returns true for a populated list', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: { partyDetails: [{ party: FIXTURE_USER_PARTY, isLocal: true }] },
    });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    expect(await client.partyExists(FIXTURE_USER_PARTY as PartyId)).toBe(true);
  });

  it('allocateParty forwards the label hint', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({
      kind: 'json',
      body: { partyDetails: { party: FIXTURE_USER_PARTY, isLocal: true } },
    });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const allocated = await client.allocateParty('User-abc123');
    expect(allocated).toBe(FIXTURE_USER_PARTY);
    expect(fake.captured[0]?.body).toEqual({ partyIdHint: 'User-abc123' });
  });
});

describe('CantonClient — write methods', () => {
  it('createCredential delegates and returns the contract id', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildCreateSubmitResponse() });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const result = await client.createCredential({
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
    });
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(fake.captured[0]?.path).toBe('/v2/commands/submit-and-wait-for-transaction');
  });

  it('verifyCredential delegates and returns the verified flag', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildVerifySubmitResponse(true) });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const result = await client.verifyCredential({
      contractId: FIXTURE_CONTRACT_ID as never,
      fetcher: FIXTURE_OPERATOR_PARTY as never,
    });
    expect(result.verified).toBe(true);
    expect(result.view.isActive).toBe(true);
  });

  it('revokeCredential delegates and returns metadata', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: buildRevokeSubmitResponse() });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const result = await client.revokeCredential({ contractId: FIXTURE_CONTRACT_ID as never });
    expect(result.contractId).toBe(FIXTURE_CONTRACT_ID);
  });
});

describe('CantonClient — read methods', () => {
  it('getLedgerEnd delegates to the underlying call', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const offset = await client.getLedgerEnd();
    expect(offset).toBe(FIXTURE_LEDGER_OFFSET);
  });

  it('listActiveCredentials delegates and returns hydrated contracts', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry()] });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const result = await client.listActiveCredentials({ includeBlob: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.payload.operator).toBe(FIXTURE_OPERATOR_PARTY);
  });

  it('findActiveCredentialByUser delegates and returns the match', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry()] });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const match = await client.findActiveCredentialByUser(FIXTURE_USER_PARTY as PartyId);
    expect(match?.contractId).toBe(FIXTURE_CONTRACT_ID);
  });

  it('findActiveCredentialByContractId delegates and returns the match', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry()] });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    const match = await client.findActiveCredentialByContractId(FIXTURE_CONTRACT_ID as ContractId);
    expect(match?.contractId).toBe(FIXTURE_CONTRACT_ID);
  });
});

describe('CantonClient — disclosure', () => {
  it('fetchDisclosureBundleByUser returns a bundle with the injected clock stamp', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry({ createdEventBlob: 'YWJj' })] });
    const client = new CantonClient({
      config,
      fetchImpl: fake.fetch,
      clock: () => FIXTURE_NOW,
    });
    const bundle = await client.fetchDisclosureBundleByUser(FIXTURE_USER_PARTY as PartyId);
    expect(bundle?.fetchedAt).toEqual(FIXTURE_NOW);
    expect(bundle?.blobBase64).toBe('YWJj');
  });

  it('fetchDisclosureBundleByContractId returns a bundle for the matching id', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
    fake.enqueue({ kind: 'json', body: [buildAcsEntry({ createdEventBlob: 'YWJj' })] });
    const client = new CantonClient({
      config,
      fetchImpl: fake.fetch,
      clock: () => FIXTURE_NOW,
    });
    const bundle = await client.fetchDisclosureBundleByContractId(
      FIXTURE_CONTRACT_ID as ContractId,
    );
    expect(bundle?.contract.contractId).toBe(FIXTURE_CONTRACT_ID);
  });
});

describe('CantonClient — diagnostics', () => {
  it('resetNamespaceCacheForTests clears only this client config', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: { participantId: FIXTURE_PARTICIPANT_ID } });
    const client = new CantonClient({ config, fetchImpl: fake.fetch });
    await client.resolveNamespace();
    expect(client.cachedNamespace()).toBe(FIXTURE_NAMESPACE);
    client.resetNamespaceCacheForTests();
    expect(client.cachedNamespace()).toBeNull();
  });
});

describe('getCantonClient singleton', () => {
  it('returns the same instance across calls', () => {
    process.env['CANTON_JSON_API_BASE_URL'] = 'http://127.0.0.1:7676';
    process.env['CANTON_OPERATOR_PARTY'] = FIXTURE_OPERATOR_PARTY;
    const a = getCantonClient();
    const b = getCantonClient();
    expect(a).toBe(b);
  });

  it('rebuilds after resetCantonClientForTests', () => {
    process.env['CANTON_JSON_API_BASE_URL'] = 'http://127.0.0.1:7676';
    process.env['CANTON_OPERATOR_PARTY'] = FIXTURE_OPERATOR_PARTY;
    const a = getCantonClient();
    resetCantonClientForTests();
    resetCantonConfigForTests();
    const b = getCantonClient();
    expect(a).not.toBe(b);
  });

  it('throws invalid_config when required env is missing', () => {
    delete process.env['CANTON_JSON_API_BASE_URL'];
    delete process.env['CANTON_OPERATOR_PARTY'];
    expect(() => getCantonClient()).toThrow(CantonError);
  });
});

describe('buildCantonClientFromEnv', () => {
  it('builds a standalone client from an explicit env record', () => {
    const client = buildCantonClientFromEnv({
      CANTON_JSON_API_BASE_URL: 'http://alt.test:7575',
      CANTON_OPERATOR_PARTY: FIXTURE_OPERATOR_PARTY,
    });
    expect(client).toBeInstanceOf(CantonClient);
    expect(client.config.baseUrl).toBe('http://alt.test:7575');
  });

  it('does not poison the singleton cache', () => {
    process.env['CANTON_JSON_API_BASE_URL'] = 'http://127.0.0.1:7676';
    process.env['CANTON_OPERATOR_PARTY'] = FIXTURE_OPERATOR_PARTY;
    const singleton = getCantonClient();
    const oneOff = buildCantonClientFromEnv({
      CANTON_JSON_API_BASE_URL: 'http://alt.test:7575',
      CANTON_OPERATOR_PARTY: FIXTURE_OPERATOR_PARTY,
    });
    expect(oneOff).not.toBe(singleton);
    expect(getCantonClient()).toBe(singleton);
  });
});
