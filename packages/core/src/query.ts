/**
 * Canton read operations — v2.0.0 (CIP #204 alignment).
 *
 * This module owns the query half of the Canton client: fetching
 * active contracts, looking up a single credential for a holder, and
 * extracting the `createdEventBlob` that a verifier participant
 * needs for explicit contract disclosure.
 *
 * None of these helpers mutate ledger state; they only `POST` to
 * the `/v2/state/active-contracts` endpoint and read from it.
 *
 * The key architectural gotcha of the Canton ACS endpoint is that
 * it returns a bare JSON array (not an object wrapper), and each
 * entry is wrapped in a double envelope
 * (`contractEntry.JsActiveContract.createdEvent`). We flatten all
 * of that here so callers see a clean `ActiveContract` value.
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
  parseCredentialPayload,
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
 * `/v2/state/active-contracts`.
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
 * shape. The wire payload is re-parsed against the credential
 * schema so any drift in the on-chain shape surfaces with a clear
 * error instead of `undefined` field reads downstream.
 *
 * Returns `null` when the wire payload fails the schema parse —
 * typically because the active-contracts query resolved the
 * package-name reference (`#canton-vc-credential:...`) to a mixed
 * set including contracts created under an older template version
 * with a different storage shape. Silent-skip is the right
 * behaviour at this layer: caller iterates and keeps the contracts
 * it can read; the unreadable rows belong to a prior package
 * version no longer part of the v2.0.0 surface and should be
 * ignored, not surfaced as a transport error.
 */
function hydrateActiveContract(
  createdEvent: ReturnType<typeof extractCreatedEvent>,
): ActiveContract | null {
  if (createdEvent === null) {
    return null;
  }
  let parsed: ReturnType<typeof parseCredentialPayload>;
  try {
    parsed = parseCredentialPayload(createdEvent.createArgument);
  } catch {
    return null;
  }
  const payload: CantonCredentialPayload = Object.freeze({
    issuer: parsed.issuer as PartyId,
    holder: parsed.holder as PartyId,
    admin: parsed.admin as PartyId,
    claims: Object.freeze({
      values: Object.freeze({ ...parsed.claims.values }),
      validFrom: parsed.claims.validFrom,
      validUntil: parsed.claims.validUntil,
      meta: Object.freeze({ ...parsed.claims.meta }),
    }),
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    meta: Object.freeze({ ...parsed.meta }),
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
 * participant.
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
 * Find the single active credential whose `payload.holder` matches
 * a given party id. Returns `null` when no match exists. Throws on
 * transport failures or multiple matches.
 */
export async function findActiveCredentialByHolder(
  config: CantonConfig,
  holderParty: PartyId,
  options: { readonly includeBlob: boolean } = { includeBlob: false },
  fetchImpl?: FetchLike,
): Promise<ActiveContract | null> {
  parsePartyId(holderParty);

  const all = await listActiveCredentials(config, options, fetchImpl);
  const matches = all.filter((contract) => contract.payload.holder === holderParty);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new CantonError(
      'ledger_error',
      `Expected at most one active Credential for holder "${holderParty}", found ${matches.length}.`,
      { context: { holderParty, matchCount: matches.length } },
    );
  }
  return matches[0] ?? null;
}

/**
 * Look up an active credential for disclosure — identical to
 * `findActiveCredentialByHolder` but asserts the blob is present.
 */
export async function fetchDisclosureBundleByHolder(
  config: CantonConfig,
  holderParty: PartyId,
  fetchImpl?: FetchLike,
  clock: () => Date = () => new Date(),
): Promise<DisclosureBundle | null> {
  const contract = await findActiveCredentialByHolder(
    config,
    holderParty,
    { includeBlob: true },
    fetchImpl,
  );
  if (contract === null) {
    return null;
  }
  if (contract.createdEventBlob === null) {
    throw new CantonError(
      'disclosure_blob_missing',
      `Canton active-contracts query returned a credential for "${holderParty}" but no createdEventBlob.`,
      { context: { holderParty, contractId: contract.contractId } },
    );
  }
  return Object.freeze({
    contract,
    blobBase64: contract.createdEventBlob,
    fetchedAt: clock(),
  });
}

/**
 * Look up a credential by its contract id.
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
 * Disclosure bundle by contract id.
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
 * contract id.
 *
 * The KycNFT template is sibling to Credential under the same
 * package; we derive its template id by swapping the `:Credential`
 * suffix on `config.packageName`.
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
 * matches the supplied credential contract id, returning the NFT
 * contract id.
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
      continue;
    }
    if (payload.boundCredentialId !== boundCredentialId) continue;
    return createdEvent.contractId as ContractId;
  }
  return null;
}
