/**
 * Tests for `./src/query` — v2.0.0 (CIP #204 alignment).
 *
 * Pins the read-side ops:
 *
 *   * `listActiveCredentials` fetches ledger end + ACS, flattens
 *     entries into the typed `ActiveContract` shape.
 *   * `findActiveCredentialByHolder` filters on `payload.holder`.
 *   * `fetchDisclosureBundleByHolder` asserts blob present + returns
 *     it alongside `fetchedAt`.
 *   * Multiple-active-credentials-per-holder is rejected.
 */

import { describe, expect, it } from 'vitest';
import type { PartyId } from '../src';
import { fetchDisclosureBundleByHolder, findActiveCredentialByHolder, listActiveCredentials } from '../src';
import {
  buildAcsEntry,
  buildFakeFetch,
  buildTestConfig,
  FIXTURE_HOLDER_PARTY,
  FIXTURE_LEDGER_OFFSET,
} from './fixtures';

const TEST_CONFIG = buildTestConfig();

function enqueueLedgerEndThenAcs(fake: ReturnType<typeof buildFakeFetch>, entries: unknown[]): void {
  fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
  fake.enqueue({ kind: 'json', body: entries });
}

describe('listActiveCredentials', () => {
  it('flattens ACS entries into typed ActiveContract values', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [buildAcsEntry()]);
    const contracts = await listActiveCredentials(
      TEST_CONFIG,
      { includeBlob: false },
      fake.fetch,
    );
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.payload.holder).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('skips entries with no JsActiveContract envelope', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [{ contractEntry: {} }, buildAcsEntry()]);
    const contracts = await listActiveCredentials(
      TEST_CONFIG,
      { includeBlob: false },
      fake.fetch,
    );
    expect(contracts).toHaveLength(1);
  });
});

describe('findActiveCredentialByHolder', () => {
  it('returns the matching active credential', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [buildAcsEntry()]);
    const contract = await findActiveCredentialByHolder(
      TEST_CONFIG,
      FIXTURE_HOLDER_PARTY as PartyId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(contract?.payload.holder).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('returns null when no match is found', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, []);
    const contract = await findActiveCredentialByHolder(
      TEST_CONFIG,
      FIXTURE_HOLDER_PARTY as PartyId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(contract).toBeNull();
  });

  it('throws when multiple active credentials exist for the same holder', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [
      buildAcsEntry({ contractId: 'cid-a' }),
      buildAcsEntry({ contractId: 'cid-b' }),
    ]);
    await expect(
      findActiveCredentialByHolder(
        TEST_CONFIG,
        FIXTURE_HOLDER_PARTY as PartyId,
        { includeBlob: false },
        fake.fetch,
      ),
    ).rejects.toThrow();
  });
});

describe('fetchDisclosureBundleByHolder', () => {
  it('returns the bundle when the blob is present', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [buildAcsEntry({ createdEventBlob: 'YWJjZGVm' })]);
    const bundle = await fetchDisclosureBundleByHolder(
      TEST_CONFIG,
      FIXTURE_HOLDER_PARTY as PartyId,
      fake.fetch,
    );
    expect(bundle?.blobBase64).toBe('YWJjZGVm');
    expect(bundle?.fetchedAt).toBeInstanceOf(Date);
  });

  it('throws when the blob is missing on an otherwise valid active contract', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, [buildAcsEntry()]);
    await expect(
      fetchDisclosureBundleByHolder(TEST_CONFIG, FIXTURE_HOLDER_PARTY as PartyId, fake.fetch),
    ).rejects.toThrow();
  });

  it('returns null when no active credential is found for the holder', async () => {
    const fake = buildFakeFetch();
    enqueueLedgerEndThenAcs(fake, []);
    const bundle = await fetchDisclosureBundleByHolder(
      TEST_CONFIG,
      FIXTURE_HOLDER_PARTY as PartyId,
      fake.fetch,
    );
    expect(bundle).toBeNull();
  });
});
