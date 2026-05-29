/**
 * High-level Canton ledger operations — v2.0.0 (CIP #204 alignment).
 *
 * This module composes the pure pieces into the three semantic
 * operations the consumer layer cares about:
 *
 *   * `createCredential()` — mints a new `Canton.VC.Credential`
 *     contract under the v2.0.0 (Pure #204) shape and returns the
 *     contract id + audit metadata.
 *   * `verifyCredential()` — exercises the standard
 *     `Credential_PublicFetch` choice (inherited from the
 *     `Cip204.Standard.Credential` interface) and returns the
 *     `CredentialView`.
 *   * `revokeCredential()` — exercises the implementer-side
 *     `RevokeCredential` choice and archives the contract.
 *
 * It does not touch any DB. Persistence happens one layer up.
 *
 * All three operations use `submit-and-wait-for-transaction`, so
 * the returned values are authoritative on success.
 *
 * Party resolution is cached per `CantonConfig`: the first call
 * fetches `/v2/parties/participant-id`, extracts the fingerprint,
 * and stores it in `party.ts`'s namespace cache.
 */

import {
  buildArchiveAsHolderCommand,
  buildBurnNftCommand,
  buildCreateCredentialCommand,
  buildCreateKycNftCommand,
  buildRevokeCredentialCommand,
  buildUpdateCredentialsCommand,
  buildCredentialFactoryUpdateExerciseCommand,
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
  ArchiveAsHolderResultSchema,
  CredentialViewSchema,
  LedgerEndResponseSchema,
  ParticipantIdResponseSchema,
  PartyAllocationResponseSchema,
  PartyLookupResponseSchema,
  type SubmitAndWaitResponse,
  SubmitAndWaitResponseSchema,
} from './schemas';
import type {
  ArchiveAsHolderInput,
  ArchiveAsHolderResult,
  BurnNftInput,
  BurnNftResult,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  CredentialView,
  LedgerOffset,
  Metadata,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  UpdateCredentialsInput,
  UpdateCredentialsResult,
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
 * Allocate a fresh party with the given label as a hint.
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
  return parsePartyId(rawAllocated).raw;
}

/* ---------- Ledger state ---------- */

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
 * Extract the `CredentialView` struct from a `Credential_PublicFetch`
 * exercise response. The choice returns the standard CIP #204
 * view; the V2 API serialises the struct under `exerciseResult`.
 */
function extractCredentialView(
  response: SubmitAndWaitResponse,
  commandId: CommandId,
): CredentialView {
  const events = response.transaction.events;
  for (const event of events) {
    if (event.ExercisedEvent !== undefined) {
      const raw = event.ExercisedEvent.exerciseResult;
      const parsed = CredentialViewSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CantonError(
          'invalid_response',
          `Canton Credential_PublicFetch exercise returned a result that does not match CredentialView: ${parsed.error.message}.`,
          { context: { commandId, updateId: response.transaction.updateId } },
        );
      }
      // Brand-coerce the validated wire shape into the nominal
      // `CredentialView` type. The schema already enforced the
      // structural invariants — this cast only adds the brand tags
      // on the embedded party id strings.
      return parsed.data as unknown as CredentialView;
    }
  }
  throw new CantonError(
    'invalid_response',
    'Canton Credential_PublicFetch exercise returned no ExercisedEvent.',
    {
      context: { commandId, updateId: response.transaction.updateId },
    },
  );
}

/* ---------- Write operations ---------- */

/**
 * Mint a new `Canton.VC.Credential` contract.
 *
 * Joint signatory per CIP #204: `actAs` carries both `issuerParty`
 * and `holderParty`. Both parties must be hosted on the submitting
 * participant. Cross-participant flows require a propose-accept
 * layer above this API.
 */
export async function createCredential(
  config: CantonConfig,
  input: CreateCredentialInput,
  fetchImpl?: FetchLike,
): Promise<CreateCredentialResult> {
  const commandId = newCommandId(config, 'create');
  const body = buildCreateCredentialCommand(config, input, commandId);

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
 * Cache the resolved `<hash>:Module:Template` form per
 * `(config, contractId)`. The cache is per-contract because Canton
 * package upgrades produce a new `lf-hash`, and contracts created
 * before an upgrade keep their old hash in their `createdEventBlob`
 * forever. The outer `WeakMap` is keyed on the config object
 * identity.
 */
const disclosedTemplateIdCache = new WeakMap<CantonConfig, Map<string, string>>();

/**
 * Resolve `config.packageName` to the form Canton accepts for
 * `DisclosedContract.templateId` for a specific contract.
 *
 * Canton 3.4's JSON Ledger v2 is asymmetric on `templateId`:
 *
 *   * `ExerciseCommand.templateId` accepts both `#name:Module:Template`
 *     (package-name reference) and `<lf-hash>:Module:Template`
 *     (canonical).
 *   * `DisclosedContract.templateId` only accepts the canonical
 *     hash form; the `#` prefix returns
 *     `400 Invalid value for: body`.
 *
 * After a package upgrade, contracts created under the old package
 * keep their old `lf-hash` in their `createdEventBlob` forever,
 * while new contracts get the new hash. The resolver returns the
 * templateId reported by the participant for the specific contract
 * we are disclosing.
 *
 * If `config.packageName` is already in hash form (no `#` prefix),
 * it is returned unchanged.
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
  // Inline ACS query — duplicating the small body shape rather
  // than importing `query.ts` to avoid a circular module
  // dependency.
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
    `Contract "${contractId}" is not in the active set under "${config.packageName}" — cannot derive the canonical templateId hash for DisclosedContract attachment.`,
    { context: { packageName: config.packageName, contractId } },
  );
}

/**
 * Exercise the standard `Credential_PublicFetch` choice on an
 * existing credential contract. The choice is nonconsuming so the
 * contract stays live after the exercise.
 *
 * The choice returns a `CredentialView` per CIP #204. The
 * implementer-side assertion `expectedAdmin == admin` is enforced
 * inside the choice body — a wrong-admin probe is rejected at the
 * chain boundary, not silently substituted.
 *
 * `actAs` is the verifier party (the choice controller). The
 * `disclosedBlobBase64` is attached for cross-participant verifies.
 */
export async function verifyCredential(
  config: CantonConfig,
  input: VerifyCredentialInput,
  fetchImpl?: FetchLike,
): Promise<VerifyCredentialResult> {
  const commandId = newCommandId(config, 'verify');
  const disclosedTemplateId =
    input.disclosedBlobBase64 !== undefined && input.disclosedBlobBase64.length > 0
      ? await resolveDisclosedTemplateId(config, input.contractId, fetchImpl)
      : undefined;
  const body = buildVerifyCredentialCommand(config, input, commandId, disclosedTemplateId);

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

  const view = extractCredentialView(response, commandId);
  return Object.freeze({
    view,
    contractId: input.contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
  });
}

/**
 * Exercise the consuming `RevokeCredential` choice. NOT part of
 * CIP #204 — implementer-specific issuer revoke path. Cascades the
 * bound NFT burn atomically when `nftContractId` is supplied.
 *
 * `actAs` is the issuer party (the choice controller). The caller
 * supplies the issuer party explicitly so this function does not
 * need to be tied to any config-level operator concept.
 */
export async function revokeCredential(
  config: CantonConfig,
  input: RevokeCredentialInput,
  issuerParty: PartyId,
  fetchImpl?: FetchLike,
): Promise<RevokeCredentialResult> {
  const commandId = newCommandId(config, 'revoke');
  const body = buildRevokeCredentialCommand(config, input, issuerParty, commandId);

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
 * CIP #204 optional factory pathway for bulk credential refresh.
 *
 * Two-step orchestration: (1) create an ephemeral
 * `CredentialFactory` contract under joint signatory issuer +
 * holder, (2) exercise `CredentialFactory_UpdateCredentials` on the
 * factory's interface with a single-entry update list. The choice
 * body archives the current credential and creates a sibling
 * carrying the replacement claims map plus optional new
 * `expiresAt`. The returned `contractId` is the new sibling's id.
 *
 * The two-step split exists because the JSON Ledger API's
 * `CreateAndExerciseCommand` only addresses template-level choices,
 * not interface choices on the template's implementations — so we
 * issue a `CreateCommand` for the factory, capture its contract id
 * from the transaction events, then issue an `ExerciseCommand`
 * against the factory's interface in a follow-up call.
 */
export async function updateCredentials(
  config: CantonConfig,
  input: UpdateCredentialsInput,
  fetchImpl?: FetchLike,
): Promise<UpdateCredentialsResult> {
  // Step 1 — create the factory.
  const factoryCreateCommandId = newCommandId(config, 'updfac');
  const factoryCreateBody = buildUpdateCredentialsCommand(
    config,
    input,
    factoryCreateCommandId,
  );
  const factoryCreateResponse = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body: factoryCreateBody,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: {
        op: 'updateCredentials.createFactory',
        commandId: factoryCreateCommandId,
        contractId: input.contractId,
      },
    },
    fetchImpl,
  );
  const factoryContractId = extractCreatedContractId(
    factoryCreateResponse,
    factoryCreateCommandId,
  );

  // Step 2 — exercise the interface choice on the factory.
  const exerciseCommandId = newCommandId(config, 'update');
  const exerciseBody = buildCredentialFactoryUpdateExerciseCommand(
    config,
    { ...input, factoryContractId },
    exerciseCommandId,
  );
  const exerciseResponse = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body: exerciseBody,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: {
        op: 'updateCredentials.exerciseFactory',
        commandId: exerciseCommandId,
        contractId: input.contractId,
      },
    },
    fetchImpl,
  );
  const newContractId = extractCreatedContractId(exerciseResponse, exerciseCommandId);
  return Object.freeze({
    contractId: newContractId,
    commandId: exerciseCommandId,
    updateId: exerciseResponse.transaction.updateId as UpdateId,
    recordTime: exerciseResponse.transaction.recordTime,
  });
}

/**
 * Exercise the CIP #204 standard `Credential_ArchiveAsHolder`
 * interface choice. Controlled by the holder; archives the
 * contract atomically and returns the now-archived `CredentialView`
 * plus the caller-supplied `meta` map per the standard.
 *
 * Distinct from `revokeCredential()`: that is the implementer-side
 * issuer compliance path; this is the holder's voluntary self-archive.
 */
export async function archiveAsHolder(
  config: CantonConfig,
  input: ArchiveAsHolderInput,
  fetchImpl?: FetchLike,
): Promise<ArchiveAsHolderResult> {
  const commandId = newCommandId(config, 'archive-holder');
  const body = buildArchiveAsHolderCommand(config, input, commandId);

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'archiveAsHolder', commandId, contractId: input.contractId },
    },
    fetchImpl,
  );

  let archived: CredentialView | null = null;
  let meta: Metadata = {};
  for (const event of response.transaction.events) {
    if (event.ExercisedEvent !== undefined) {
      const raw = event.ExercisedEvent.exerciseResult;
      const parsed = ArchiveAsHolderResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CantonError(
          'invalid_response',
          `Canton Credential_ArchiveAsHolder exercise returned a result that does not match Credential_ArchiveAsHolderResult: ${parsed.error.message}.`,
          { context: { commandId, updateId: response.transaction.updateId } },
        );
      }
      archived = parsed.data.archivedCredential as unknown as CredentialView;
      meta = parsed.data.meta;
      break;
    }
  }
  if (archived === null) {
    throw new CantonError(
      'invalid_response',
      'Canton Credential_ArchiveAsHolder exercise returned no ExercisedEvent.',
      { context: { commandId, updateId: response.transaction.updateId } },
    );
  }

  return Object.freeze({
    contractId: input.contractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
    view: archived,
    meta,
  });
}

/**
 * Standalone burn of a `KycNFT` contract. Exercises the `BurnNft`
 * template choice — controlled by the NFT's issuer. Independent of
 * the cascade burn that `revokeCredential` triggers when supplied
 * with an NFT contract id.
 */
export async function burnNft(
  config: CantonConfig,
  input: BurnNftInput,
  fetchImpl?: FetchLike,
): Promise<BurnNftResult> {
  const commandId = newCommandId(config, 'burn-nft');
  const body = buildBurnNftCommand(config, input, commandId);

  const response = await cantonFetch(
    config,
    {
      method: 'POST',
      path: '/v2/commands/submit-and-wait-for-transaction',
      body,
      schema: SubmitAndWaitResponseSchema,
      retry: 'never',
      context: { op: 'burnNft', commandId, contractId: input.nftContractId },
    },
    fetchImpl,
  );

  return Object.freeze({
    contractId: input.nftContractId,
    commandId,
    updateId: response.transaction.updateId as UpdateId,
    recordTime: response.transaction.recordTime,
  });
}

/**
 * Mint a `KycNFT` contract bound to the given credential. The NFT
 * is an optional companion artefact — NOT part of CIP #204.
 *
 * The caller supplies `issuerParty` (the signatory). The DAML
 * template ensure clause enforces non-empty field constraints at
 * the chain boundary; the SDK forwards string values verbatim.
 *
 * Cascade burn lives in `revokeCredential`: the caller passes
 * `nftContractId` so the choice body atomically archives the NFT
 * in the same Canton transaction as the credential revoke.
 */
export async function createKycNft(
  config: CantonConfig,
  input: CreateKycNftInput,
  issuerParty: PartyId,
  fetchImpl?: FetchLike,
  commandIdOverride?: CommandId,
): Promise<CreateKycNftResult> {
  const commandId = commandIdOverride ?? newCommandId(config, 'create-nft');
  const body = buildCreateKycNftCommand(config, input, issuerParty, commandId);

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
