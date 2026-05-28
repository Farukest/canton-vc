/**
 * Canton V2 JSON Ledger client — public surface (v2.0.0).
 *
 * Consumers should import from the package root (`@canton-vc/core`)
 * rather than reaching into individual files. The barrel re-exports
 * every type, constant, and function that belongs to the public
 * contract of the library — internal helpers stay unexported.
 *
 * Layering:
 *
 *   * `errors`   — single error class + code union
 *   * `config`   — env-backed Zod config with per-process cache
 *   * `types`    — branded identifiers + CIP #204 data shapes + claim accessors
 *   * `schemas`  — Zod schemas for V2 API response shapes
 *   * `party`    — party-id parsing + namespace resolution cache
 *   * `http`     — `fetch` wrapper with timeout, retry, error mapping
 *   * `commands` — pure builders for V2 create/exercise command bodies
 *   * `ledger`   — high-level write ops (create / verify / revoke)
 *   * `query`    — read ops (ACS + disclosure blob extraction)
 *   * `client`   — facade class + process singleton
 *   * `explorer` — public-explorer URL builders (ccview.io defaults)
 */

export type { CantonClientOptions } from './client';
export {
  buildCantonClientFromEnv,
  CantonClient,
  getCantonClient,
  resetCantonClientForTests,
} from './client';
export type {
  CreateCredentialArguments,
  CreateKycNftArguments,
  DisclosedContract,
  SubmitAndWaitRequestBody,
} from './commands';
export {
  buildArchiveAsHolderCommand,
  buildBurnNftCommand,
  buildCreateCredentialCommand,
  buildCreateKycNftCommand,
  buildRevokeCredentialCommand,
  buildUpdateCredentialsCommand,
  buildVerifyCredentialCommand,
  deterministicCommandId,
  MAX_COMMAND_ID_LENGTH,
  newCommandId,
  TRANSACTION_SHAPE_LEDGER_EFFECTS,
} from './commands';
export type { CantonConfig, CantonEnv, CantonRequiredEnv } from './config';
export {
  CantonConfigSchema,
  getCantonConfig,
  loadCantonConfig,
  PACKAGE_NAME_REGEX,
  resetCantonConfigForTests,
} from './config';
export type { CantonErrorCode } from './errors';
export { CantonError, isCantonError, isCantonErrorWithCode } from './errors';
export { cantonExplorerTransferUrl, truncateContractId } from './explorer';
export type { CantonFetchOptions, FetchLike, FetchLikeResponse } from './http';
export { cantonFetch, cantonFetchOnce } from './http';
export {
  allocateParty,
  archiveAsHolder,
  burnNft,
  createCredential,
  createKycNft,
  getLedgerEnd,
  partyExists,
  resolveNamespace,
  revokeCredential,
  updateCredentials,
  verifyCredential,
} from './ledger';
export type { ParsedPartyId } from './party';
export {
  asPartyIdUnchecked,
  buildPartyId,
  cacheNamespace,
  getCachedNamespace,
  isPartyId,
  isSameParty,
  parsePartyId,
  participantIdToNamespace,
  partyIdFromHint,
  resetAllNamespaceCachesForTests,
  resetNamespaceCacheForConfig,
  resolvePartyFromInput,
} from './party';
export type {
  CanonicalForm,
  ProofHashLeafValue,
  ProofHashResult,
  ProofHashValues,
  ProofSchemaSpec,
} from './proof-hash';
export {
  CANONICAL_FORM_DEFAULT,
  canonicalJson,
  computeProofHash,
  computeSchemaId,
  shortenFloats,
  sortKeys,
} from './proof-hash';
export {
  fetchDisclosureBundleByContractId,
  fetchDisclosureBundleByHolder,
  fetchKycNftByContractId,
  findActiveCredentialByContractId,
  findActiveCredentialByHolder,
  findActiveKycNftByCredentialId,
  listActiveCredentials,
} from './query';
export type {
  ActiveContractEntryWire,
  ActiveContractsResponse,
  ArchiveAsHolderResultWire,
  CantonApiError,
  CantonCredentialPayloadWire,
  ClaimsWire,
  CreatedEventWire,
  CredentialViewWire,
  ExercisedEventWire,
  KycNftPayloadWire,
  LedgerEndResponse,
  ParticipantIdResponse,
  PartyAllocationResponse,
  PartyLookupResponse,
  SubmitAndWaitResponse,
  TransactionEventWire,
} from './schemas';
export {
  ActiveContractsResponseSchema,
  ArchiveAsHolderResultSchema,
  CantonApiErrorSchema,
  CredentialViewSchema,
  LedgerEndResponseSchema,
  ParticipantIdResponseSchema,
  PartyAllocationResponseSchema,
  PartyLookupResponseSchema,
  parseCredentialPayload,
  parseKycNftPayload,
  SubmitAndWaitResponseSchema,
} from './schemas';
export type {
  ActiveContract,
  ArchiveAsHolderInput,
  ArchiveAsHolderResult,
  Brand,
  BurnNftInput,
  BurnNftResult,
  CantonCredentialPayload,
  Claims,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  CredentialView,
  DisclosureBundle,
  KycNftPayload,
  LedgerOffset,
  Metadata,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  TemplateId,
  UpdateCredentialsInput,
  UpdateCredentialsResult,
  UpdateId,
  VerifyCredentialInput,
  VerifyCredentialResult,
} from './types';
export {
  createClaimSchema,
  getBoolClaim,
  getClaim,
  getIntClaim,
  isWithinValidityWindow,
} from './types';
