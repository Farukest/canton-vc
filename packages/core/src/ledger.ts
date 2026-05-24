/**
 * High-level Canton ledger operations: create / verify / revoke
 * credential, plus the party-resolution bootstrap that every
 * write needs.
 *
 * This module composes the pure pieces below into the three
 * semantic operations the route layer cares about:
 *
 *   * `createCredential()` — mints a new `KYCCredential` contract
 *     for a user and returns the contract id + audit metadata.
 *   * `verifyCredential()` — exercises `Verify` (nonconsuming) on a
 *     live contract and returns the boolean result from the choice.
 *   * `revokeCredential()` — exercises `RevokeCredential` and
 *     archives the contract.
 *
 * It *doesn't* touch the DB. Persistence happens one layer up,
 * inside the route handler, so the Canton client can be used from
 * worker jobs and background reconcilers without a transaction
 * around it.
 *
 * All three operations use `submit-and-wait-for-transaction`, which
 * means the returned contract id / boolean is authoritative: if we
 * got a response, the command succeeded at the Daml layer.
 *
 * Party resolution is cached per `CantonConfig`: the first call
 * fetches `/v2/parties/participant-id`, extracts the fingerprint,
 * and stores it in `party.ts`'s namespace cache. Subsequent calls
 * are free.
 */

import {
  buildCreateCredentialCommand,
  buildCreateKycNftCommand,
  buildRevokeCredentialCommand,
  buildVerifyCredentialCommand,
  newCommandId,
} from './commands';
import type { CantonConfig } from './config';
import { CantonError } from './errors';
import { cantonFetch, type FetchLike } from './http';
import {
  cacheNamespace,
  getCachedNamespace,
  parsePartyId,
  participantIdToNamespace,
} from './party';
import {
  ActiveContractsResponseSchema,
  KycCredentialViewSchema,
  LedgerEndResponseSchema,
  ParticipantIdResponseSchema,
  PartyAllocationResponseSchema,
  PartyLookupResponseSchema,
  type SubmitAndWaitResponse,
  SubmitAndWaitResponseSchema,
} from './schemas';
import type {
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  CredentialView,
  LedgerOffset,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  UpdateId,
  VerifyCredentialInput,
  VerifyCredentialResult,
} from './types';

/* ---------- Party resolution ---------- */

/**
 * Fetch the participant id, extract its namespace (fingerprint),
 * cache it, and return it. No-op when the cache is already warm.
 */
export async function resolveNamespace(
  config: CantonConfig,
  fetchImpl?: FetchLike,
): Promise<string> {
  const cached = getCachedNamespace(config);
  if (cached !== null) {
    return cached;
  }
  const response = await cantonFetch(
    config,
    {
      method: 'GET',
      path: '/v2/parties/participant-id',
      schema: ParticipantIdResponseSchema,
      context: { op: 'resolveNamespace' },
    },
    fetchImpl,
  );
  const participantId = response.participantId;
  const namespace = participantIdToNamespace(participantId);
  cacheNamespace(config, namespace);
  return namespace;
}

/**
 * Check whether a full party id already exists on the participant.
 * Used before building a command that acts on an existing user.
 */
export async function partyExists(
  config: CantonConfig,
  partyId: PartyId,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  try {
    const encoded = encodeURIComponent(partyId);
    const response = await cantonFetch(
      config,
      {
        method: 'GET',
        path: `/v2/parties/${encoded}`,
        schema: PartyLookupResponseSchema,
        context: { op: 'partyExists', partyId },
      },
      fetchImpl,
    );
    return response.partyDetails.length > 0;
  } catch (err) {
    if (err instanceof CantonError && err.code === 'not_found') {
      return false;
    }
    throw err;
  }
}

/**
 * Allocate a fresh party with the given label as a hint. Participant
 * returns the full party id (including namespace). Only called when
 * `CantonConfig.allocateMissingParties` is `true`.
 */
export async function allocateParty(
  config: CantonConfig,
  labelHint: string,
  fetchImpl?: FetchLike,
): Promise<PartyId> {
  if (typeof labelHint !== 'string' || labelHint.length === 0) {
    throw new CantonError('invalid_party', 'allocateParty: label hint must be a non-empty string.');
  }
  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/parties',
      body: { partyIdHint: labelHint },
      schema: PartyAllocationResponseSchema,
      retry: 'never',
      context: { op: 'allocateParty', labelHint },
    },
    fetchImpl,
  );
  const rawAllocated = response.partyDetails.party;
  if (typeof rawAllocated !== 'string' || rawAllocated.length === 0) {
    throw new CantonError(
      'party_allocation_failed',
      `Canton returned empty partyDetails.party for hint "${labelHint}".`,
      { context: { labelHint, response } },
    );
  }
  // Validate the shape before branding.
  return parsePartyId(rawAllocated).raw;
}

/* ---------- Ledger state ---------- */

/**
 * Fetch the current ledger end offset. Used for `activeAtOffset`
 * pagination + as a cheap liveness probe.
 */
export async function getLedgerEnd(
  config: CantonConfig,
  fetchImpl?: FetchLike,
): Promise<LedgerOffset> {
  const response = await cantonFetch(
    config,
    {
      method: 'GET',
      path: '/v2/state/ledger-end',
      schema: LedgerEndResponseSchema,
      context: { op: 'getLedgerEnd' },
    },
    fetchImpl,
  );
  return response.offset as LedgerOffset;
}

/* ---------- Event extraction helpers ---------- */

/**
 * Extract the single `CreatedEvent` from a submit-and-wait response.
 * Throws `contract_not_found` if none is present.
 */
function extractCreatedContractId(
  response: SubmitAndWaitResponse,
  commandId: CommandId,
): ContractId {
  const events = response.transaction.events;
  for (const event of events) {
    if (event.CreatedEvent !== undefined) {
      return event.CreatedEvent.contractId as ContractId;
    }
  }
  throw new CantonError(
    'submit_failed',
    'Canton create-credential submission returned no CreatedEvent.',
    { context: { commandId, updateId: response.transaction.updateId } },
  );
}

/**
 * Extract the `CredentialView` struct from an `Verify` exercise
 * response. The `Verify` choice returns
 * `CredentialView` (record), so the V2 API serialises the
 * struct under `exerciseResult` as a JSON object whose keys mirror
 * the Daml field names. The schema parses the shape and rejects
 * any drift.
 */
function extractVerifyView(
  response: SubmitAndWaitResponse,
  commandId: CommandId,
): CredentialView {
  const events = response.transaction.events;
  for (const event of events) {
    if (event.ExercisedEvent !== undefined) {
      const raw = event.ExercisedEvent.exerciseResult;
      const parsed = KycCredentialViewSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CantonError(
          'invalid_response',
          `Canton Verify exercise returned a result that does not match CredentialView: ${parsed.error.message}.`,
          { context: { commandId, updateId: response.transaction.updateId } },
        );
      }
      // Wire shape uses Daml-side casing (capitalised constructors).
      // The `CredentialView` interface in `types.ts` uses the
      // same casing — no remapping required, just a type assertion
      // to widen `string`-typed enum fields back into their narrow
      // union shape.
      return parsed.data as unknown as CredentialView;
    }
  }
  throw new CantonError('invalid_response', 'Canton Verify exercise returned no ExercisedEvent.', {
    context: { commandId, updateId: response.transaction.updateId },
  });
}

/* ---------- Write operations ---------- */

/**
 * Mint a new `KYCCredential` contract for a user.
 *
 * Responsibilities:
 *   1. Resolve the operator party from config (parses + brands).
 *   2. Mint a command id.
 *   3. Build the V2 `CreateCommand` envelope.
 *   4. POST to `submit-and-wait-for-transaction` (no retry — writes).
 *   5. Extract the new contract id from the `CreatedEvent`.
 *   6. Return a structured result the route layer persists.
 */
export async function createCredential(
  config: CantonConfig,
  input: CreateCredentialInput,
  fetchImpl?: FetchLike,
): Promise<CreateCredentialResult> {
  const operatorParty = parsePartyId(config.operatorParty).raw;
  const commandId = newCommandId(config, 'create');
  const body = buildCreateCredentialCommand(config, input, operatorParty, commandId);

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'createCredential', commandId },
    },
    fetchImpl,
  );

  const contractId = extractCreatedContractId(response, commandId);
  return Object.freeze({
    contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
    completionOffset: response.transaction.offset as LedgerOffset,
  });
}

/**
 * Exercise the nonconsuming `Verify` choice on an existing credential
 * contract. the template returns a `CredentialView`
 * struct rather than a `Bool`; the struct carries the
 * server-evaluated `isActive` flag plus every field a firm needs
 * to make a non-custodial decision (userRef, proofHash,
 * level, validUntil, network, scores, validator, individual
 * verification flags). The convenience `verified` field on the
 * result mirrors `view.isActive` so legacy yes/no call sites keep
 * working.
 */
/**
 * Cache the resolved `<hash>:Module:Template` form per
 * `(config, contractId)`. The cache is per-contract because Canton
 * package upgrades produce a new `lf-hash`, and contracts created
 * before an upgrade keep their old hash in their `createdEventBlob`
 * forever — `DisclosedContract.template_id` MUST match the blob's
 * embedded id, so different contracts on the same participant may
 * legitimately need different hashes. Resolved lazily on the first
 * `verifyCredential()` call for each `contractId`, then reused for
 * every subsequent call on the same `(config, contractId)` pair.
 * The outer `WeakMap` is keyed on the config object identity so a
 * process holding multiple `CantonConfig` instances (multi-network
 * test harness) caches each independently.
 */
const disclosedTemplateIdCache = new WeakMap<CantonConfig, Map<string, string>>();

/**
 * Resolve `config.packageName` to the form Canton accepts for
 * `DisclosedContract.templateId` **for a specific contract**.
 *
 * Canton 3.4's JSON Ledger v2 is asymmetric on `templateId`:
 *
 *   * `ExerciseCommand.templateId` accepts both `#name:Module:Template`
 *     (package-name reference, resolved server-side via the package
 *     store — needed for smart-contract upgrade plumbing) and
 *     `<lf-hash>:Module:Template` (canonical).
 *   * `DisclosedContract.templateId` only accepts the canonical hash
 *     form; the `#` prefix returns
 *     `400 Invalid value for: body (non expected character 0x23 in
 *      Daml-LF Package ID …)`. The participant cannot use the package
 *     store here because the disclosed contract authentication step
 *     re-derives the contract id hash from the blob, and the blob
 *     embeds its own package id — name resolution would be ambiguous
 *     across upgrade versions.
 *
 * Critical: after a package upgrade, contracts created under the old
 * package keep their old `lf-hash` in their `createdEventBlob` forever,
 * while new contracts get the new hash. Both are reachable through the
 * same `#name` reference. Picking "any" contract's templateId is wrong;
 * we MUST use the templateId reported by the participant for the
 * specific contract we are disclosing, since both fields come from the
 * same ACS entry and are guaranteed consistent with the blob.
 *
 * If `config.packageName` is already in hash form (no `#` prefix),
 * it is returned unchanged. Otherwise the resolver queries the
 * participant's active-contract set under the `#name` reference,
 * locates the entry for `contractId`, and returns its canonical
 * templateId. The result is cached per `(config, contractId)`.
 *
 * Throws `package_id_unresolved` when the participant returns no
 * matching active contract — either the contract is archived, the
 * contract id is wrong, or no mints have happened yet.
 */
async function resolveDisclosedTemplateId(
  config: CantonConfig,
  contractId: ContractId,
  fetchImpl?: FetchLike,
): Promise<string> {
  if (!config.packageName.startsWith('#')) {
    return config.packageName;
  }
  let perContract = disclosedTemplateIdCache.get(config);
  const cached = perContract?.get(contractId);
  if (cached !== undefined) {
    return cached;
  }
  // Inline ACS query — duplicating the small body shape rather than
  // importing `query.ts` to avoid a circular module dependency
  // (query.ts already imports `getLedgerEnd` from this file). We ask
  // for `includeBlob: false` because we only need the resolved
  // templateId from the matching entry, not the payloads.
  const offset = await getLedgerEnd(config, fetchImpl);
  const acsBody = {
    filter: {
      filtersByParty: {},
      filtersForAnyParty: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId: config.packageName,
                  includeCreatedEventBlob: false,
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
  const entries = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/state/active-contracts',
      body: acsBody,
      schema: ActiveContractsResponseSchema,
      retry: 'auto',
      context: {
        op: 'resolveDisclosedTemplateId',
        packageName: config.packageName,
        contractId,
      },
    },
    fetchImpl,
  );
  for (const entry of entries) {
    const createdEvent = entry.contractEntry.JsActiveContract?.createdEvent;
    if (createdEvent === undefined) continue;
    if (createdEvent.contractId !== contractId) continue;
    const resolved = createdEvent.templateId;
    if (typeof resolved === 'string' && resolved.length > 0 && !resolved.startsWith('#')) {
      if (perContract === undefined) {
        perContract = new Map();
        disclosedTemplateIdCache.set(config, perContract);
      }
      perContract.set(contractId, resolved);
      return resolved;
    }
  }
  throw new CantonError(
    'package_id_unresolved',
    `Contract "${contractId}" is not in the active set under "${config.packageName}" — cannot derive the canonical templateId hash for DisclosedContract attachment. The contract may be archived, the id may be wrong, or no mints have happened yet.`,
    { context: { packageName: config.packageName, contractId } },
  );
}

export async function verifyCredential(
  config: CantonConfig,
  input: VerifyCredentialInput,
  fetchImpl?: FetchLike,
): Promise<VerifyCredentialResult> {
  const operatorParty = parsePartyId(config.operatorParty).raw;
  const commandId = newCommandId(config, 'verify');
  // Only pay the resolver cost when we will actually attach a
  // `DisclosedContract`. The operator-side self-verify path (no blob)
  // takes `ExerciseCommand.templateId` which accepts `#name:…` directly.
  const disclosedTemplateId =
    input.disclosedBlobBase64 !== undefined && input.disclosedBlobBase64.length > 0
      ? await resolveDisclosedTemplateId(config, input.contractId, fetchImpl)
      : undefined;
  const body = buildVerifyCredentialCommand(
    config,
    input,
    operatorParty,
    commandId,
    disclosedTemplateId,
  );

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'verifyCredential', commandId, contractId: input.contractId },
    },
    fetchImpl,
  );

  const view = extractVerifyView(response, commandId);
  return Object.freeze({
    verified: view.isActive,
    view,
    contractId: input.contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
  });
}

/**
 * Exercise the consuming `RevokeCredential` choice. Archives the
 * contract. No explicit payload returned beyond the transaction
 * metadata.
 */
export async function revokeCredential(
  config: CantonConfig,
  input: RevokeCredentialInput,
  fetchImpl?: FetchLike,
): Promise<RevokeCredentialResult> {
  const operatorParty = parsePartyId(config.operatorParty).raw;
  const commandId = newCommandId(config, 'revoke');
  const body = buildRevokeCredentialCommand(config, input, operatorParty, commandId);

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'revokeCredential', commandId, contractId: input.contractId },
    },
    fetchImpl,
  );

  return Object.freeze({
    contractId: input.contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
  });
}

/**
 * Mint a `KycNFT` contract bound to the given credential.
 *
 * v1.1.0 of the package introduced the soulbound showcase NFT
 * (`Canton.VC.Credential.KycNFT`). It is minted in a separate Canton
 * submission immediately after the credential mint succeeds, with
 * `boundCredentialId` set to the new credential's contract id.
 *
 * Mint precondition: `level === 'enhanced'`. Basic-level credentials
 * never receive an NFT — the Daml ensure clause rejects any
 * `level != "Enhanced"` at the chain boundary, and the worker also
 * skips the call entirely for Basic to avoid wasted submissions.
 *
 * Cascade burn lives in `revokeCredential`: the worker passes
 * `nftContractId` so the choice body atomically archives the NFT in
 * the same Canton tx as the credential.
 */
export async function createKycNft(
  config: CantonConfig,
  input: CreateKycNftInput,
  fetchImpl?: FetchLike,
  commandIdOverride?: import('./types').CommandId,
): Promise<CreateKycNftResult> {
  const operatorParty = parsePartyId(config.operatorParty).raw;
  // Caller can pin a deterministic command id (Canton-side dedup) by
  // passing `commandIdOverride`. Default behaviour stays random for
  // every legacy callsite and for tests.
  const commandId = commandIdOverride ?? newCommandId(config, 'create-nft');
  const body = buildCreateKycNftCommand(config, input, operatorParty, commandId);

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'createKycNft', commandId, boundCredentialId: input.boundCredentialId },
    },
    fetchImpl,
  );

  const contractId = extractCreatedContractId(response, commandId);
  return Object.freeze({
    contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
    completionOffset: response.transaction.offset as LedgerOffset,
  });
}
