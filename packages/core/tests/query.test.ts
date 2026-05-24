/**
 * Tests for `./src/query`.
 *
 * `query.ts` is the read-side of the Canton client. These tests stub
 * `cantonFetch` via `buildFakeFetch()` and exercise:
 *
 *   * `listActiveCredentials` — fetches ledger-end + ACS, hydrates
 *     entries, respects `includeBlob`, skips non-JsActiveContract
 *     entries, uses explicit `offset` when provided.
 *   * `findActiveCredentialByUser` — happy path, null when absent,
 *     `ledger_error` on multiple matches, party shape validation.
 *   * `findActiveCredentialByContractId` — same shape, rejects empty
 *     contract id.
 *   * `fetchDisclosureBundleByUser` / `…ByContractId` — wraps
 *     contract + blob + clock timestamp, throws
 *     `disclosure_blob_missing` when blob is absent.
 */

import { describe, expect, it } from 'vitest';

import type { ContractId, PartyId } from '../src';
import {
  type CantonError,
  fetchDisclosureBundleByContractId,
  fetchDisclosureBundleByUser,
  findActiveCredentialByContractId,
  findActiveCredentialByUser,
  isCantonErrorWithCode,
  listActiveCredentials,
} from '../src';

import {
  buildAcsEntry,
  buildFakeFetch,
  buildTestConfig,
  FIXTURE_CONTRACT_ID,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_NAMESPACE,
  FIXTURE_NOW,
  FIXTURE_USER_PARTY,
} from './fixtures';

/**
 * Enqueue the ledger-end probe + an ACS body. The probe happens
 * because `listActiveCredentials` resolves the offset itself when
 * none is supplied.
 */
function enqueueListFlow(
  fake: ReturnType<typeof buildFakeFetch>,
  acsBody: readonly unknown[],
): void {
  fake.enqueue({ kind: 'json', body: { offset: FIXTURE_LEDGER_OFFSET } });
  fake.enqueue({ kind: 'json', body: acsBody });
}

describe('listActiveCredentials', () => {
  it('fetches ledger-end first, then ACS with that offset', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    const result = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(result).toHaveLength(1);
    expect(fake.captured[0]?.path).toBe('/v2/state/ledger-end');
    expect(fake.captured[1]?.path).toBe('/v2/state/active-contracts');
  });

  it('skips the ledger-end probe when an explicit offset is supplied', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    fake.enqueue({ kind: 'json', body: [buildAcsEntry()] });
    const result = await listActiveCredentials(
      config,
      { includeBlob: false, offset: FIXTURE_LEDGER_OFFSET },
      fake.fetch,
    );
    expect(result).toHaveLength(1);
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0]?.path).toBe('/v2/state/active-contracts');
  });

  it('passes includeBlob through to the filter body', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ createdEventBlob: 'YWJj' })]);
    await listActiveCredentials(config, { includeBlob: true }, fake.fetch);
    const body = fake.captured[1]?.body as {
      filter: {
        filtersForAnyParty: {
          cumulative: Array<{
            identifierFilter: { TemplateFilter: { value: { includeCreatedEventBlob: boolean } } };
          }>;
        };
      };
      activeAtOffset: string;
    };
    expect(
      body.filter.filtersForAnyParty.cumulative[0]?.identifierFilter.TemplateFilter.value
        .includeCreatedEventBlob,
    ).toBe(true);
    expect(body.activeAtOffset).toBe(FIXTURE_LEDGER_OFFSET);
  });

  it('hydrates the contract id, templateId, and payload from a created event', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    const [first] = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(first?.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(first?.templateId).toBe('#canton-vc-credential:Canton.VC.Credential:Credential');
    expect(first?.payload.user).toBe(FIXTURE_USER_PARTY);
    expect(first?.payload.status).toBe('Active');
    expect(first?.payload.level).toBe('Enhanced');
    expect(first?.payload.userRef).toBe('firm-user-fixture');
    expect(first?.payload.validator).toBe('DiditValidator');
  });

  it('propagates createdEventBlob into the hydrated contract when present', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ createdEventBlob: 'YWJjZGVm' })]);
    const [first] = await listActiveCredentials(config, { includeBlob: true }, fake.fetch);
    expect(first?.createdEventBlob).toBe('YWJjZGVm');
  });

  it('sets createdEventBlob to null when the blob is absent', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    const [first] = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(first?.createdEventBlob).toBeNull();
  });

  it('returns a frozen readonly array', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    const result = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns an empty array when the ACS is empty', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, []);
    const result = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(result).toEqual([]);
  });

  it('returns multiple hydrated contracts in order', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [
      buildAcsEntry({ contractId: '00aaaa' }),
      buildAcsEntry({
        contractId: '00bbbb',
        user: `User-xyz::${FIXTURE_NAMESPACE}`,
      }),
    ]);
    const result = await listActiveCredentials(config, { includeBlob: false }, fake.fetch);
    expect(result).toHaveLength(2);
    expect(result[0]?.contractId).toBe('00aaaa');
    expect(result[1]?.contractId).toBe('00bbbb');
  });
});

describe('findActiveCredentialByUser', () => {
  it('returns the matching contract for the user party', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    const match = await findActiveCredentialByUser(
      config,
      FIXTURE_USER_PARTY as PartyId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(match?.contractId).toBe(FIXTURE_CONTRACT_ID);
    expect(match?.payload.user).toBe(FIXTURE_USER_PARTY);
  });

  it('returns null when no active credential matches', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ user: `User-other::${FIXTURE_NAMESPACE}` })]);
    const match = await findActiveCredentialByUser(
      config,
      FIXTURE_USER_PARTY as PartyId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(match).toBeNull();
  });

  it('throws ledger_error when multiple credentials match', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [
      buildAcsEntry({ contractId: '00aa' }),
      buildAcsEntry({ contractId: '00bb' }),
    ]);
    try {
      await findActiveCredentialByUser(
        config,
        FIXTURE_USER_PARTY as PartyId,
        { includeBlob: false },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('ledger_error');
      expect((err as CantonError).message).toMatch(/at most one/);
    }
  });

  it('validates the input party shape before any fetch', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    try {
      await findActiveCredentialByUser(
        config,
        'garbage' as unknown as PartyId,
        { includeBlob: false },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_party')).toBe(true);
    }
    expect(fake.captured).toHaveLength(0);
  });
});

describe('findActiveCredentialByContractId', () => {
  it('returns the matching contract by contract id', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [
      buildAcsEntry({ contractId: '00aaaa' }),
      buildAcsEntry({ contractId: '00bbbb' }),
    ]);
    const match = await findActiveCredentialByContractId(
      config,
      '00bbbb' as ContractId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(match?.contractId).toBe('00bbbb');
  });

  it('returns null when no contract matches', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ contractId: '00aaaa' })]);
    const match = await findActiveCredentialByContractId(
      config,
      '00zzzz' as ContractId,
      { includeBlob: false },
      fake.fetch,
    );
    expect(match).toBeNull();
  });

  it('rejects an empty contract id before fetching', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    try {
      await findActiveCredentialByContractId(
        config,
        '' as ContractId,
        { includeBlob: false },
        fake.fetch,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_contract_id')).toBe(true);
    }
    expect(fake.captured).toHaveLength(0);
  });
});

describe('fetchDisclosureBundleByUser', () => {
  it('returns a bundle with contract + blob + fetchedAt timestamp', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ createdEventBlob: 'YWJjZGVm' })]);
    const bundle = await fetchDisclosureBundleByUser(
      config,
      FIXTURE_USER_PARTY as PartyId,
      fake.fetch,
      () => FIXTURE_NOW,
    );
    expect(bundle).not.toBeNull();
    expect(bundle?.blobBase64).toBe('YWJjZGVm');
    expect(bundle?.fetchedAt).toEqual(FIXTURE_NOW);
    expect(bundle?.contract.contractId).toBe(FIXTURE_CONTRACT_ID);
  });

  it('returns null when no active credential exists for the user', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, []);
    const bundle = await fetchDisclosureBundleByUser(
      config,
      FIXTURE_USER_PARTY as PartyId,
      fake.fetch,
      () => FIXTURE_NOW,
    );
    expect(bundle).toBeNull();
  });

  it('throws disclosure_blob_missing when the contract exists but no blob', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    // Note: no createdEventBlob overrides → no blob in the entry.
    enqueueListFlow(fake, [buildAcsEntry()]);
    try {
      await fetchDisclosureBundleByUser(
        config,
        FIXTURE_USER_PARTY as PartyId,
        fake.fetch,
        () => FIXTURE_NOW,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('disclosure_blob_missing');
    }
  });

  it('requests includeBlob=true in the ACS filter', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ createdEventBlob: 'YWJj' })]);
    await fetchDisclosureBundleByUser(
      config,
      FIXTURE_USER_PARTY as PartyId,
      fake.fetch,
      () => FIXTURE_NOW,
    );
    const body = fake.captured[1]?.body as {
      filter: {
        filtersForAnyParty: {
          cumulative: Array<{
            identifierFilter: { TemplateFilter: { value: { includeCreatedEventBlob: boolean } } };
          }>;
        };
      };
    };
    expect(
      body.filter.filtersForAnyParty.cumulative[0]?.identifierFilter.TemplateFilter.value
        .includeCreatedEventBlob,
    ).toBe(true);
  });
});

describe('fetchDisclosureBundleByContractId', () => {
  it('returns a bundle when the contract matches', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ createdEventBlob: 'YWJj' })]);
    const bundle = await fetchDisclosureBundleByContractId(
      config,
      FIXTURE_CONTRACT_ID as ContractId,
      fake.fetch,
      () => FIXTURE_NOW,
    );
    expect(bundle?.blobBase64).toBe('YWJj');
    expect(bundle?.contract.contractId).toBe(FIXTURE_CONTRACT_ID);
  });

  it('returns null when no contract matches the id', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry({ contractId: '00aaaa' })]);
    const bundle = await fetchDisclosureBundleByContractId(
      config,
      '00zzzz' as ContractId,
      fake.fetch,
      () => FIXTURE_NOW,
    );
    expect(bundle).toBeNull();
  });

  it('throws disclosure_blob_missing when the contract exists but no blob', async () => {
    const config = buildTestConfig();
    const fake = buildFakeFetch();
    enqueueListFlow(fake, [buildAcsEntry()]);
    try {
      await fetchDisclosureBundleByContractId(
        config,
        FIXTURE_CONTRACT_ID as ContractId,
        fake.fetch,
        () => FIXTURE_NOW,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).code).toBe('disclosure_blob_missing');
    }
  });
});
