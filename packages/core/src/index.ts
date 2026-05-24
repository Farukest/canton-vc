/**
 * Canton V2 JSON Ledger client — public surface.
 *
 * Consumers should import from the package root (`@canton-vc/core`)
 * rather than reaching into individual files. The barrel re-exports
 * every type, constant, and function that belongs to the public
 * contract of the library — internal helpers used only by one module
 * stay unexported.
 *
 * Layering:
 *
 *   * `errors`   — single error class + code union
 *   * `config`   — env-backed Zod config with per-process cache
 *   * `types`    — branded identifiers + Daml/DB enum mappings + payload types
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
  CreateKycCredentialArguments,
  CreateKycNftArguments,
  DisclosedContract,
  SubmitAndWaitRequestBody,
} from './commands';
export {
  buildCreateCredentialCommand,
  buildCreateKycNftCommand,
  buildRevokeCredentialCommand,
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
  createCredential,
  createKycNft,
  getLedgerEnd,
  partyExists,
  resolveNamespace,
  revokeCredential,
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
  fetchDisclosureBundleByUser,
  fetchKycNftByContractId,
  findActiveCredentialByContractId,
  findActiveCredentialByUser,
  findActiveKycNftByCredentialId,
  listActiveCredentials,
} from './query';
export type {
  ActiveContractEntryWire,
  ActiveContractsResponse,
  CantonApiError,
  CreatedEventWire,
  ExercisedEventWire,
  KycCredentialPayloadWire,
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
  CantonApiErrorSchema,
  LedgerEndResponseSchema,
  ParticipantIdResponseSchema,
  PartyAllocationResponseSchema,
  PartyLookupResponseSchema,
  parseKycCredentialPayload,
  parseKycNftPayload,
  SubmitAndWaitResponseSchema,
} from './schemas';
export type {
  ActiveContract,
  Brand,
  CanonicalNetwork,
  CantonCredentialPayload,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  CredentialStatus,
  CredentialView,
  DamlCredentialStatus,
  DamlKycLevel,
  DamlValidatorType,
  DisclosureBundle,
  KycLevel,
  KycNftPayload,
  LedgerOffset,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  TemplateId,
  UpdateId,
  Validator,
  VerifyCredentialInput,
  VerifyCredentialResult,
} from './types';
export {
  DAML_TO_DB_LEVEL,
  DAML_TO_DB_STATUS,
  DAML_TO_DB_VALIDATOR,
  DB_TO_DAML_LEVEL,
  DB_TO_DAML_STATUS,
  DB_TO_DAML_VALIDATOR,
} from './types';
