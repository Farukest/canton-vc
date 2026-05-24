/**
 * Canton read operations.
 *
 * This module owns the *query* half of the Canton client: fetching
 * active contracts, looking up a single credential for a user, and
 * extracting the `createdEventBlob` that the firm participant needs
 * for explicit contract disclosure.
 *
 * None of these helpers mutate ledger state; they only `POST` to the
 * `/v2/state/active-contracts` endpoint and read from it.
 *
 * The key architectural gotcha of the Canton ACS endpoint is that
 * it returns a bare JSON array (not an object wrapper), and each
 * entry is wrapped in a double envelope (`contractEntry.JsActiveContract.createdEvent`).
 * We flatten all of that here so callers see a clean
 * `ActiveContract` value.
 */

import type { CantonConfig } from './config';
import { CantonError } from './errors';
import { cantonFetch, type FetchLike } from './http';
import { getLedgerEnd } from './ledger';
import { parsePartyId } from './party';
import {
  type ActiveContractEntryWire,
  ActiveContractsResponseSchema,
  type KycNftPayloadWire,
  parseKycCredentialPayload,
  parseKycNftPayload,
} from './schemas';
import type {
  ActiveContract,
  CantonCredentialPayload,
  ContractId,
  DisclosureBundle,
  PartyId,
  TemplateId,
} from './types';

/* ---------- Body builder ---------- */

/**
 * Build the `filter` + `activeAtOffset` shape expected by
 * `/v2/state/active-contracts`. `includeBlob` toggles whether the
 * participant embeds `createdEventBlob` in each entry — blobs are
 * ~1-3 KiB so we only ask when we actually need to disclose.
 */
function buildActiveContractsBody(
  templateId: string,
  offset: string,
  includeBlob: boolean,
): unknown {
  return {
    filter: {
      filtersByParty: {},
      filtersForAnyParty: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId,
                  includeCreatedEventBlob: includeBlob,
                },
              },
            },
          },
        ],
      },
    },
    verbose: true,
    activeAtOffset: offset,
  };
}

/* ---------- Flatten helpers ---------- */

/**
 * Pull the `CreatedEvent` out of a wire entry, if present. Canton's
 * ACS stream occasionally returns assignment/reassignment entries
 * we don't care about — those are skipped by returning `null`.
 */
function extractCreatedEvent(
  entry: ActiveContractEntryWire,
):
  | NonNullable<
      NonNullable<ActiveContractEntryWire['contractEntry']['JsActiveContract']>
    >['createdEvent']
  | null {
  const envelope = entry.contractEntry.JsActiveContract;
  if (envelope === undefined) {
    return null;
  }
  return envelope.createdEvent;
}

/**
 * Convert a wire created-event into the nominal `ActiveContract`
 * shape. Brand-coerces the strings into their respective branded
 * types after the schema has already validated them.
 */
function hydrateActiveContract(
  createdEvent: ReturnType<typeof extractCreatedEvent>,
): ActiveContract | null {
  if (createdEvent === null) {
    return null;
  }
  // The ACS query was already filtered server-side to the credential
  // template, but the response schema (`CreatedEventSchema`) keeps
  // `createArgument` untyped so the same shape works for KycNFT and
  // future template mints. Re-parse here against the credential
  // schema so any drift in the on-chain payload still surfaces with
  // a clear error instead of `undefined` field reads downstream.
  const parsed = parseKycCredentialPayload(createdEvent.createArgument);
  const payload: CantonCredentialPayload = Object.freeze({
    operator: parsed.operator as PartyId,
    user: parsed.user as PartyId,
    userRef: parsed.userRef,
    proofHash: parsed.proofHash,
    status: parsed.status,
    level: parsed.level,
    validUntil: parsed.validUntil,
    network: parsed.network,
    humanScore: parsed.humanScore,
    validator: parsed.validator,
    identityVerified: parsed.identityVerified,
    livenessVerified: parsed.livenessVerified,
    addressVerified: parsed.addressVerified,
    proofSchemaId: parsed.proofSchemaId ?? null,
  });

  const rawBlob = createdEvent.createdEventBlob;
  const blob = typeof rawBlob === 'string' && rawBlob.length > 0 ? rawBlob : null;

  return Object.freeze({
    contractId: createdEvent.contractId as ContractId,
    templateId: createdEvent.templateId as TemplateId,
    payload,
    signatories: Object.freeze((createdEvent.signatories ?? []).slice()) as readonly PartyId[],
    observers: Object.freeze((createdEvent.observers ?? []).slice()) as readonly PartyId[],
    createdEventBlob: blob,
  });
}

/* ---------- Queries ---------- */

/**
 * Fetch every active `Canton.VC.Credential` contract on the
 * participant. Returns a freshly constructed array; the order is
 * whatever the participant returned (we do not sort here).
 *
 * `includeBlob` controls whether each entry embeds the
 * `createdEventBlob`. The caller should only ask for it when a
 * disclosure is about to happen — otherwise it's wasted bandwidth.
 */
export async function listActiveCredentials(
  config: CantonConfig,
  options: {
    readonly includeBlob: boolean;
    readonly offset?: string;
  },
  fetchImpl?: FetchLike,
): Promise<readonly ActiveContract[]> {
  const offset = options.offset ?? (await getLedgerEnd(config, fetchImpl));
  const body = buildActiveContractsBody(config.packageName, offset, options.includeBlob);

  const entries = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/state/active-contracts',
      body,
      schema: ActiveContractsResponseSchema,
      retry: 'auto',
      context: { op: 'listActiveCredentials', includeBlob: options.includeBlob, offset },
    },
    fetchImpl,
  );

  const hydrated: ActiveContract[] = [];
  for (const entry of entries) {
    const createdEvent = extractCreatedEvent(entry);
    const contract = hydrateActiveContract(createdEvent);
    if (contract !== null) {
      hydrated.push(contract);
    }
  }
  return Object.freeze(hydrated);
}

/**
 * Find the single active credential whose `payload.user` matches a
 * given party id. Returns `null` when no match exists. Throws on
 * transport failures or multiple matches (multiple active
 * credentials for a single user is a Daml-level invariant break
 * that should surface immediately).
 */
export async function findActiveCredentialByUser(
  config: CantonConfig,
  userParty: PartyId,
  options: { readonly includeBlob: boolean } = { includeBlob: false },
  fetchImpl?: FetchLike,
): Promise<ActiveContract | null> {
  // Ensure the input party has a valid shape before we walk results.
  parsePartyId(userParty);

  const all = await listActiveCredentials(config, options, fetchImpl);
  const matches = all.filter((contract) => contract.payload.user === userParty);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new CantonError(
      'ledger_error',
      `Expected at most one active KYCCredential for user "${userParty}", found ${matches.length}.`,
      { context: { userParty, matchCount: matches.length } },
    );
  }
  return matches[0] ?? null;
}

/**
 * Look up an active credential for disclosure — identical to
 * `findActiveCredentialByUser` but asserts the blob is present and
 * wraps it in a `DisclosureBundle` with the fetch timestamp.
 *
 * The `fetchedAt` timestamp is stamped at the moment the query
 * returns, so the route layer can persist it alongside the cached
 * blob in `kyc_credentials_meta.disclosure_blob_fetched_at`.
 */
export async function fetchDisclosureBundleByUser(
  config: CantonConfig,
  userParty: PartyId,
  fetchImpl?: FetchLike,
  clock: () => Date = () => new Date(),
): Promise<DisclosureBundle | null> {
  const contract = await findActiveCredentialByUser(
    config,
    userParty,
    { includeBlob: true },
    fetchImpl,
  );
  if (contract === null) {
    return null;
  }
  if (contract.createdEventBlob === null) {
    throw new CantonError(
      'disclosure_blob_missing',
      `Canton active-contracts query returned a credential for "${userParty}" but no createdEventBlob.`,
      { context: { userParty, contractId: contract.contractId } },
    );
  }
  return Object.freeze({
    contract,
    blobBase64: contract.createdEventBlob,
    fetchedAt: clock(),
  });
}

/**
 * Look up a credential by its contract id. Scans the active-
 * contracts list for a match; no dedicated single-contract endpoint
 * exists in V2.
 */
export async function findActiveCredentialByContractId(
  config: CantonConfig,
  contractId: ContractId,
  options: { readonly includeBlob: boolean } = { includeBlob: false },
  fetchImpl?: FetchLike,
): Promise<ActiveContract | null> {
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new CantonError(
      'invalid_contract_id',
      'findActiveCredentialByContractId: contractId must be a non-empty string.',
    );
  }
  const all = await listActiveCredentials(config, options, fetchImpl);
  const match = all.find((contract) => contract.contractId === contractId);
  return match ?? null;
}

/**
 * Disclosure bundle by contract id — used by the firm API's
 * `/v1/credentials/{id}/disclosure` endpoint. Same semantics as
 * `fetchDisclosureBundleByUser`, keyed on contract id instead.
 */
export async function fetchDisclosureBundleByContractId(
  config: CantonConfig,
  contractId: ContractId,
  fetchImpl?: FetchLike,
  clock: () => Date = () => new Date(),
): Promise<DisclosureBundle | null> {
  const contract = await findActiveCredentialByContractId(
    config,
    contractId,
    { includeBlob: true },
    fetchImpl,
  );
  if (contract === null) {
    return null;
  }
  if (contract.createdEventBlob === null) {
    throw new CantonError(
      'disclosure_blob_missing',
      `Canton active-contracts query returned contract ${contractId} but no createdEventBlob.`,
      { context: { contractId } },
    );
  }
  return Object.freeze({
    contract,
    blobBase64: contract.createdEventBlob,
    fetchedAt: clock(),
  });
}

/* ---------- KycNFT ---------- */

/**
 * Fetch a `Canton.VC.Credential.KycNFT` contract payload by its
 * contract id. The KycNFT template is sibling to Credential under
 * the same package; we derive its template id by swapping the
 * `:Credential` suffix on `config.packageName`. Mirrors the suffix
 * derivation used in `commands.ts::buildCreateKycNftCommand`.
 *
 * The Canton V2 ACS endpoint has no single-contract query, so we
 * fetch the active KycNFT set and filter client-side. Returns `null`
 * when the contract is not in the active set (i.e. the NFT was
 * burned via DAML cascade after the bound credential was archived).
 *
 * The returned `image` field is the immutable base64 SVG written at
 * mint time. Callers trust the bytes verbatim — DOMPurify
 * sanitisation runs in the worker pre-mint and the on-chain write is
 * one-shot.
 */
export async function fetchKycNftByContractId(
  config: CantonConfig,
  contractId: ContractId,
  fetchImpl?: FetchLike,
): Promise<KycNftPayloadWire | null> {
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new CantonError(
      'invalid_contract_id',
      'fetchKycNftByContractId: contractId must be a non-empty string.',
    );
  }

  const nftTemplateId = `${config.packageName.replace(/:Credential$/, '')}:KycNFT`;
  const offset = await getLedgerEnd(config, fetchImpl);
  const body = buildActiveContractsBody(nftTemplateId, offset, /* includeBlob */ false);

  const entries = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/state/active-contracts',
      body,
      schema: ActiveContractsResponseSchema,
      retry: 'auto',
      context: { op: 'fetchKycNftByContractId', contractId, offset },
    },
    fetchImpl,
  );

  for (const entry of entries) {
    const createdEvent = extractCreatedEvent(entry);
    if (createdEvent === null) continue;
    if (createdEvent.contractId !== contractId) continue;
    return parseKycNftPayload(createdEvent.createArgument);
  }
  return null;
}

/**
 * Locate the active `KycNFT` contract whose `boundCredentialId`
 * matches the supplied credential contract id, returning both the
 * NFT contract id and the participant-stamped update id of its mint.
 * Returns `null` when no such NFT exists in the active set (either
 * the NFT was never minted, or it has been burned by the cascade-
 * archive choice).
 *
 * Used by the reconciler's stuck-NFT-mint pass: when the customer-
 * triggered NFT mint endpoint crashed mid-handler (Canton submit
 * succeeded but the post-Canton DB UPDATE never landed), the
 * deterministic command id guarantees the chain has the NFT but
 * the DB is missing the cross-reference. This helper rehydrates
 * the row from the on-chain artefact.
 *
 * Implementation note: the JSON Ledger API V2 has no
 * `find-by-create-argument` endpoint, so we fetch the active KycNFT
 * set and filter client-side. The set is small in practice (one row
 * per Enhanced customer) and the call runs from a 15-minute cron,
 * so the cost is acceptable. If the set ever grows materially, a
 * dedicated indexed query in the participant store is the next step.
 */
export async function findActiveKycNftByCredentialId(
  config: CantonConfig,
  boundCredentialId: ContractId,
  fetchImpl?: FetchLike,
): Promise<ContractId | null> {
  if (typeof boundCredentialId !== 'string' || boundCredentialId.length === 0) {
    throw new CantonError(
      'invalid_contract_id',
      'findActiveKycNftByCredentialId: boundCredentialId must be a non-empty string.',
    );
  }
  const nftTemplateId = `${config.packageName.replace(/:Credential$/, '')}:KycNFT`;
  const offset = await getLedgerEnd(config, fetchImpl);
  const body = buildActiveContractsBody(nftTemplateId, offset, /* includeBlob */ false);

  const entries = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/state/active-contracts',
      body,
      schema: ActiveContractsResponseSchema,
      retry: 'auto',
      context: { op: 'findActiveKycNftByCredentialId', boundCredentialId, offset },
    },
    fetchImpl,
  );

  for (const entry of entries) {
    const createdEvent = extractCreatedEvent(entry);
    if (createdEvent === null) continue;
    let payload: ReturnType<typeof parseKycNftPayload>;
    try {
      payload = parseKycNftPayload(createdEvent.createArgument);
    } catch {
      // Older / malformed NFT row — skip rather than abort the scan.
      continue;
    }
    if (payload.boundCredentialId !== boundCredentialId) continue;
    return createdEvent.contractId as ContractId;
  }
  return null;
}
