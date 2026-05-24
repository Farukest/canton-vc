/**
 * Canton client types.
 *
 * This module defines the *nominal* types that flow through the
 * Canton client. Branded strings (`PartyId`, `ContractId`, etc.)
 * prevent accidental cross-use at the type level even though every
 * value is a runtime `string`. Constructors are defined in the modules
 * that validate them (`party.ts` for `PartyId`, `commands.ts` for
 * `CommandId`) so that a brand can only be minted through a validated
 * path, never by hand.
 *
 * The payload types mirror the fields of the `Canton.VC.Credential`
 * Daml template on a 1:1 basis. They are the ground-truth for the
 * on-ledger shape: any schema drift in the Daml model requires an
 * update here and a corresponding migration of any persisted meta
 * rows that carry the old shape.
 */

/* ---------- Branded primitives ---------- */

declare const brand: unique symbol;

/**
 * Generic brand helper. Widens a primitive type with a unique nominal
 * tag, so `PartyId` and `ContractId` can both be `string` at runtime
 * but are not assignable to each other at compile time.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * Canton party identifier. Format: `<Label>::<Fingerprint>`.
 *
 * The label is an alphanumeric name (e.g. `Operator`) and the
 * fingerprint is a hex SHA-256 prefixed with the Canton protocol tag
 * (`1220` for the current format). The client exposes this as an
 * opaque string to route handlers: the only valid way to construct
 * one is through `parsePartyId()` or `buildPartyId()` in `party.ts`.
 */
export type PartyId = Brand<string, 'PartyId'>;

/**
 * Canton contract identifier. Format is participant-specific; in
 * practice it is a long hex string (~200+ chars) that uniquely
 * identifies an active contract on the ledger. We never parse its
 * internal structure — we only forward the opaque value to the
 * participant on exercise / disclosure calls.
 */
export type ContractId = Brand<string, 'ContractId'>;

/**
 * Canton template identifier. Format: `#<package-name>:<Module>:<Template>`.
 *
 * Canton 3.4+ mandates the package-name form (package-id references
 * are discontinued). The `#` prefix is what distinguishes this from a
 * raw module path. Stored as `canton_template_id` in the DB.
 */
export type TemplateId = Brand<string, 'TemplateId'>;

/**
 * Canton command identifier. A short opaque string we generate per
 * submit-and-wait call. Bounded to `maxCommandIdLength` to keep
 * participant logs tidy. Uniqueness is a soft guarantee (timestamp +
 * random suffix) and the participant will deduplicate within a short
 * window if we somehow collide.
 */
export type CommandId = Brand<string, 'CommandId'>;

/**
 * Offset into the Canton ledger log. Opaque string; participant is
 * authoritative. Used for pagination and `activeAtOffset` queries.
 */
export type LedgerOffset = Brand<string, 'LedgerOffset'>;

/**
 * Transaction / update identifier returned by a successful submit.
 * Opaque to us; we stash it so operators can correlate an audit
 * line with the Canton transaction log on the validator side.
 */
export type UpdateId = Brand<string, 'UpdateId'>;

/* ---------- Daml-side enums ---------- */

/**
 * Daml `ValidatorType` enum variants. Note the `Validator` suffix —
 * the Daml constructors include it so the payload must serialize as
 * e.g. `"DiditValidator"` when sent into a `CreateCommand`. Mirrors
 * the DAML `ValidatorType` data constructor set 1:1.
 *
 * DB layer uses the lowercase stripped form (see `Validator`);
 * the mapping lives in `payloadToMeta` / `metaToPayload` inside
 * `query.ts`.
 */
export type DamlValidatorType =
  | 'DiditValidator'
  | 'OnfidoValidator'
  | 'PersonaValidator'
  | 'SumsubValidator'
  | 'VeriffValidator'
  | 'Au10tixValidator'
  | 'JumioValidator'
  | 'ZkValidator'
  | 'Generic';

/**
 * Daml `KYCStatus` enum variants. Capitalized to match the Daml
 * constructors. The DB enum uses the lowercase form.
 */
export type DamlCredentialStatus = 'Pending' | 'Active' | 'Revoked' | 'Expired';

/**
 * Daml `KYCLevel` enum variants. Capitalized to match the Daml
 * constructors. The DB enum uses the lowercase form.
 *
 * the predecessor template version collapsed the level vocabulary from
 * {Basic, Standard, Enhanced} → {Basic, Enhanced}. The intermediate
 * "Standard" tier was redundant: address verification is the only
 * thing that distinguished Standard from Basic, and the on-chain
 * shape now folds that into `Enhanced` so a single `addressVerified`
 * boolean carries the same signal without a tri-valued enum the
 * `ensure` clause has to police.
 */
export type DamlKycLevel = 'Basic' | 'Enhanced';

/**
 * DB-side KYC level enum (lowercase). Matches `kyc_level` pgEnum.
 */
export type KycLevel = 'basic' | 'enhanced';

/**
 * DB-side credential status enum (lowercase). Matches
 * `credential_status` pgEnum.
 */
export type CredentialStatus = 'pending' | 'active' | 'revoked' | 'expired';

/**
 * DB-side validator enum (lowercase). Matches `credential_validator`
 * pgEnum.
 */
export type Validator =
  | 'didit'
  | 'onfido'
  | 'persona'
  | 'sumsub'
  | 'veriff'
  | 'au10tix'
  | 'jumio'
  | 'zk'
  | 'generic';

/**
 * Canonical network tag. Matches `canonical_network` pgEnum and the
 * Canton config `network` field.
 */
export type CanonicalNetwork = 'mainnet' | 'devnet';

/* ---------- Daml ↔ DB enum mappings ---------- */

/**
 * Daml capitalized status → DB lowercase status. Total — every Daml
 * status has a DB counterpart.
 */
export const DAML_TO_DB_STATUS: Readonly<Record<DamlCredentialStatus, CredentialStatus>> =
  Object.freeze({
    Pending: 'pending',
    Active: 'active',
    Revoked: 'revoked',
    Expired: 'expired',
  });

/**
 * DB lowercase status → Daml capitalized status. Inverse of
 * `DAML_TO_DB_STATUS`. Used when we build a `CreateCommand` from a
 * DB-side record.
 */
export const DB_TO_DAML_STATUS: Readonly<Record<CredentialStatus, DamlCredentialStatus>> =
  Object.freeze({
    pending: 'Pending',
    active: 'Active',
    revoked: 'Revoked',
    expired: 'Expired',
  });

/**
 * Daml level → DB level.
 */
export const DAML_TO_DB_LEVEL: Readonly<Record<DamlKycLevel, KycLevel>> = Object.freeze({
  Basic: 'basic',
  Enhanced: 'enhanced',
});

/**
 * DB level → Daml level.
 */
export const DB_TO_DAML_LEVEL: Readonly<Record<KycLevel, DamlKycLevel>> = Object.freeze({
  basic: 'Basic',
  enhanced: 'Enhanced',
});

/**
 * Daml validator constructor → DB validator enum.
 */
export const DAML_TO_DB_VALIDATOR: Readonly<Record<DamlValidatorType, Validator>> = Object.freeze({
  DiditValidator: 'didit',
  OnfidoValidator: 'onfido',
  PersonaValidator: 'persona',
  SumsubValidator: 'sumsub',
  VeriffValidator: 'veriff',
  Au10tixValidator: 'au10tix',
  JumioValidator: 'jumio',
  ZkValidator: 'zk',
  Generic: 'generic',
});

/**
 * DB validator → Daml constructor.
 */
export const DB_TO_DAML_VALIDATOR: Readonly<Record<Validator, DamlValidatorType>> = Object.freeze({
  didit: 'DiditValidator',
  onfido: 'OnfidoValidator',
  persona: 'PersonaValidator',
  sumsub: 'SumsubValidator',
  veriff: 'VeriffValidator',
  au10tix: 'Au10tixValidator',
  jumio: 'JumioValidator',
  zk: 'ZkValidator',
  generic: 'Generic',
});

/* ---------- Payload types ---------- */

/**
 * `Canton.VC.Credential` on-ledger payload. Matches the template
 * declaration in `daml/canton-vc-credential/daml/Canton/VC/Credential.daml`.
 *
 * `validUntil` is an ISO 8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.sss]Z`)
 * — the on-ledger representation uses a Daml `Time`, which Canton
 * serializes as a full timestamp string in JSON. The route layer
 * converts between this and the `timestamptz` column.
 *
 * `humanScore` is a Daml `Int`, which Canton serializes as a JSON
 * number. We clamp it to 0..100 in the command builder.
 *
 * The three `*Verified` flags are Daml `Bool` — true/false in JSON,
 * converted to `integer 0|1` in the DB row (the schema uses `integer`
 * for atomic counters).
 */
export interface CantonCredentialPayload {
  readonly operator: PartyId;
  readonly user: PartyId;
  /**
   * Firm-facing user identifier the credential is bound to at mint
   * time. Added in the predecessor template version so consuming firms can
   * verify a credential is "for the user I expect" by comparing the
   * `userRef` in the decoded blob to their own internal record. The
   * template `ensure` clause rejects an empty string so a misconfigured
   * worker cannot mint a credential without a binding.
   */
  readonly userRef: string;
  readonly proofHash: string;
  readonly status: DamlCredentialStatus;
  readonly level: DamlKycLevel;
  readonly validUntil: string; // ISO 8601 timestamp `YYYY-MM-DDTHH:MM:SSZ`
  readonly network: string;
  readonly humanScore: number;
  readonly validator: DamlValidatorType;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  /**
   * v1.1.0 addition: content-addressed id of the `ProofSchemaSpec` that
   * the issuer used to compute `proofHash`. `null` only for legacy
   * v1.0.0 contracts (which were minted before audit-replay was
   * standardised); v1.1.0+ mints always carry a non-empty schema id.
   */
  readonly proofSchemaId: string | null;
}

/**
 * Arguments accepted by `createCredential()`. This is the shape the
 * route handler passes in; the client translates it into a
 * `CreateCommand` body internally.
 *
 * All fields are validated at the schema boundary — nothing here
 * comes directly from the HTTP body of a firm request.
 */
export interface CreateCredentialInput {
  readonly userParty: PartyId;
  /**
   * Firm-facing user identifier — opaque to Canton. The worker passes
   * the customer UUID for self-service mints and the firm-supplied
   * `userRef` for B2B mints. the template stamps this onto
   * the on-chain payload so verifying firms can match the decoded
   * blob to their own record without trusting the issuer's sidecar JSON.
   * Must be a non-empty string — the template's `ensure` clause
   * rejects blanks at mint time.
   */
  readonly userRef: string;
  readonly proofHash: string;
  /**
   * Content-addressed id of the {@link ProofSchemaSpec} that produced
   * `proofHash`. Required on every v1.1.0+ mint — the DAML ensure
   * clause rejects an empty/missing value. The schema spec itself
   * lives in the public registry under `docs/proof-schemas/<id>.json`.
   */
  readonly proofSchemaId: string;
  readonly status: CredentialStatus;
  readonly level: KycLevel;
  readonly validUntil: string; // ISO 8601 timestamp `YYYY-MM-DDTHH:MM:SSZ`
  readonly humanScore: number;
  readonly validator: Validator;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
}

/**
 * Result of a successful `createCredential()` call. `updateId` lets
 * callers correlate with the Canton transaction log; `recordTime` is
 * stamped by the participant for audit ordering.
 */
export interface CreateCredentialResult {
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string; // ISO 8601 datetime
  readonly completionOffset: LedgerOffset;
}

/**
 * Arguments accepted by `verifyCredential()`. The `Verify` choice is
 * `nonconsuming`, so the contract stays live after the exercise.
 *
 * `fetcher` is the party submitting the exercise — under the canton-vc credential
 * flexible-controller template it is the choice's `controller`, so
 * the participant network identity layer (party allocation +
 * namespace fingerprint) is the only thing required to authorize the
 * call. The disclosed contract blob is attached separately by the
 * Canton client; Canton's contract-authentication step rejects a
 * tampered blob before the choice body runs.
 */
export interface VerifyCredentialInput {
  readonly contractId: ContractId;
  readonly fetcher: PartyId;
  /**
   * Optional disclosed-contract blob (base64url) when the verifier
   * does not have the contract in its local ACS — i.e. cross-firm
   * verification where the participant has never observed the mint.
   * When provided it is attached as a `DisclosedContract` on the
   * command. When omitted (operator-side verify, ACS already holds
   * it) the participant resolves the contract from local state.
   */
  readonly disclosedBlobBase64?: string;
}

/**
 * Result of a `verifyCredential()` call. the Daml `Verify` widening of
 * `Verify` choice from `Bool` to a full `CredentialView` struct so
 * the firm reads every credential field from the choice result
 * instead of trusting a plaintext sidecar JSON. The participant runs
 * the choice body with chain time, so `isActive` is server-evaluated
 * (status == "Active" && now <= validUntil) — firms do not have to
 * compare `validUntil` against their own clock.
 *
 * The `verified` boolean stays as a convenience: it mirrors `view.isActive`
 * so legacy call sites that just want a yes/no answer keep working.
 */
export interface VerifyCredentialResult {
  readonly verified: boolean;
  readonly view: CredentialView;
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
}

/**
 * Mirror of the Daml `CredentialView` record returned by the
 * `Verify` choice. Fields use the wire shape (lowercase enum
 * variants for level/status, capitalized constructor for validator —
 * matches Daml-LF JSON encoding) so the Canton client forwards the
 * server's answer verbatim and the route layer maps to its own
 * shape only at the API boundary.
 */
export interface CredentialView {
  readonly userRef: string;
  readonly proofHash: string;
  readonly status: DamlCredentialStatus;
  readonly level: DamlKycLevel;
  readonly validUntil: string; // ISO 8601 timestamp `YYYY-MM-DDTHH:MM:SSZ`
  readonly network: string;
  readonly humanScore: number;
  readonly validator: DamlValidatorType;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  readonly isActive: boolean;
  /**
   * v1.1.0 addition: content-addressed schema id used to compute
   * `proofHash`. `null` for legacy v1.0.0 credentials (treated as
   * audit-incomplete by downstream verifiers).
   */
  readonly proofSchemaId: string | null;
}

/**
 * Arguments accepted by `revokeCredential()`. `RevokeCredential` is a
 * consuming choice — the contract is archived on success.
 *
 * `nftContractId` is the optional bound `KycNFT` contract id; when
 * present, the choice body atomically archives the NFT in the same
 * Canton transaction (cascade burn). NULL for Basic-level credentials
 * which never had an NFT minted under the v1.1.0 ensure clause
 * `level == "Enhanced"`.
 */
export interface RevokeCredentialInput {
  readonly contractId: ContractId;
  readonly nftContractId?: ContractId;
}

/**
 * Result of a `revokeCredential()` call. No return value beyond the
 * completion acknowledgement.
 */
export interface RevokeCredentialResult {
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
}

/**
 * Active contract returned by an ACS query. `createdEventBlob` is
 * only populated when the query asked for disclosure — it is the
 * serialized event the firm needs to verify the credential against
 * their own participant (`explicit contract disclosure`).
 */
export interface ActiveContract {
  readonly contractId: ContractId;
  readonly templateId: TemplateId;
  readonly payload: CantonCredentialPayload;
  readonly signatories: readonly PartyId[];
  readonly observers: readonly PartyId[];
  readonly createdEventBlob: string | null; // base64 when requested, null otherwise
}

/**
 * Result of a disclosure-style query: a single active contract plus
 * the blob ready to be forwarded to a firm participant.
 */
export interface DisclosureBundle {
  readonly contract: ActiveContract;
  readonly blobBase64: string;
  readonly fetchedAt: Date;
}

/* ---------- KycNFT (v1.1.0) ---------- */

/**
 * Arguments accepted by `createKycNft()`. The NFT is minted only for
 * Enhanced-level credentials — the Daml ensure clause rejects any
 * `level != "Enhanced"` at the chain boundary.
 *
 * `image` is an inline `data:image/svg+xml;base64,…` URI rendered on
 * the customer dashboard via `<img>` (browser sandbox + CSP). The
 * worker pre-sanitizes the SVG with DOMPurify before encoding.
 */
export interface CreateKycNftInput {
  readonly customerParty: PartyId;
  readonly boundCredentialId: ContractId;
  readonly level: 'enhanced';
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
}

/**
 * Result of a successful `createKycNft()` call.
 */
export interface CreateKycNftResult {
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
  readonly completionOffset: LedgerOffset;
}

/**
 * On-ledger payload of `Canton.VC.Credential.KycNFT`. Mirrors the
 * Daml template fields 1:1.
 */
export interface KycNftPayload {
  readonly operator: PartyId;
  readonly customer: PartyId;
  readonly boundCredentialId: ContractId;
  readonly issuedAt: string;
  readonly level: 'Enhanced';
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
}
