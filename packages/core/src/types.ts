/**
 * Canton client types — v2.0.0 (CIP #204 alignment).
 *
 * This module defines the generic types that flow through the Canton
 * Verifiable Credentials SDK. Application-specific concerns (KYC
 * vendor enums, level/status vocabularies, reverse-DNS claim
 * namespaces, lifecycle semantics) live in consumer code — the SDK
 * is intentionally agnostic to any specific issuer.
 *
 * Branded strings (`PartyId`, `ContractId`, …) prevent cross-use at
 * the type level even though every value is a runtime `string`.
 * Constructors live in the modules that validate them (`party.ts`,
 * `commands.ts`).
 *
 * The payload type mirrors the `Canton.VC.Credential` v2.0.0
 * template, which implements the `Cip204.Standard.Credential`
 * interface. The on-ledger shape is:
 *
 *   * `issuer`, `holder`, `admin` — three named parties per #204.
 *   * `claims` — `Claims { values, validFrom, validUntil, meta }`
 *     where `values` is a TextMap of namespace-prefixed (Java-style
 *     reverse-DNS) credential attributes.
 *   * `createdAt`, `expiresAt` — `Optional Time` on the view.
 *   * `meta` — `TextMap Text` for non-business metadata.
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
 */
export type PartyId = Brand<string, 'PartyId'>;

/**
 * Canton contract identifier. Format is participant-specific; in
 * practice it is a long hex string (~200+ chars).
 */
export type ContractId = Brand<string, 'ContractId'>;

/**
 * Canton template identifier. Format: `#<package-name>:<Module>:<Template>`.
 */
export type TemplateId = Brand<string, 'TemplateId'>;

/**
 * Canton command identifier.
 */
export type CommandId = Brand<string, 'CommandId'>;

/**
 * Offset into the Canton ledger log. Opaque string; participant is
 * authoritative. Used for pagination and `activeAtOffset` queries.
 */
export type LedgerOffset = Brand<string, 'LedgerOffset'>;

/**
 * Transaction / update identifier returned by a successful submit.
 */
export type UpdateId = Brand<string, 'UpdateId'>;

/* ---------- CIP #204 core data shapes ---------- */

/**
 * CIP #204 `Metadata` — a free-form `TextMap Text` for namespace-
 * prefixed key/value pairs that do not carry business meaning. Carried
 * on `Claims.meta` and `CredentialView.meta`.
 *
 * CIP #204 §"Namespacing" reserves the `cip-<nr>/` prefix for keys
 * defined by the standard itself; application-extension keys MUST use
 * Java-style reverse-DNS (e.g. `com.example/role`). Enforcement is a
 * wire-format concern handled at the application layer — the SDK
 * accepts any string key.
 *
 * Encoded on the wire as a JSON object with string keys/values.
 */
export type Metadata = Readonly<Record<string, string>>;

/**
 * CIP #204 `Claims` — the credential's business payload.
 *
 *   * `values` — TextMap of `<namespace>/<property>` → text. Numeric
 *     and boolean claims are text-encoded (`"92"`, `"true"`) per
 *     spec. Consumers decode at the namespace boundary.
 *   * `validFrom` / `validUntil` — Optional Time (`string | null` on
 *     the wire) for credentials that have an explicit validity
 *     window.
 *   * `meta` — free-form Metadata.
 */
export interface Claims {
  readonly values: Readonly<Record<string, string>>;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly meta: Metadata;
}

/**
 * CIP #204 `CredentialView` — the standard view returned by
 * `Credential_PublicFetch` and the `viewtype` of the `Credential`
 * interface. Identical to the on-ledger template payload (the
 * interface view is a 1:1 projection of the template fields).
 *
 * Note: lifecycle semantics ("active vs. expired vs. revoked") are
 * implementer-defined under CIP #204. The standard view itself has
 * no `isActive` flag — applications evaluate lifecycle from
 * `expiresAt` and any status claims they choose to encode under
 * their own reverse-DNS namespace.
 */
export interface CredentialView {
  readonly admin: PartyId;
  readonly issuer: PartyId;
  readonly holder: PartyId;
  readonly claims: Claims;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly meta: Metadata;
}

/**
 * On-ledger payload of the `Canton.VC.Credential` template. Identical
 * to `CredentialView` since the template's `interface instance` view
 * mirrors the storage fields 1:1.
 */
export type CantonCredentialPayload = CredentialView;

/* ---------- Input / output types for the SDK methods ---------- */

/**
 * Arguments accepted by `createCredential()`.
 *
 * Generic by design — application code (KYC issuers, supply-chain
 * issuers, attestation issuers, …) assembles the `Claims` map with
 * its own reverse-DNS namespace and passes it through. The SDK
 * does not interpret claim contents.
 *
 * Joint signatory: the template is signed by both `issuerParty` and
 * `holderParty` (CIP #204 mandate). The SDK submits with both
 * parties in the `actAs` list — both must be hosted on the
 * submitting participant. Cross-participant flows require a
 * propose-accept layer above this API.
 */
export interface CreateCredentialInput {
  /**
   * The issuer party. Co-signs the credential alongside the holder
   * per CIP #204. In a custodian model, this is the operator party
   * the SDK was configured with.
   */
  readonly issuerParty: PartyId;
  /**
   * The holder party. Co-signs the credential alongside the issuer.
   */
  readonly holderParty: PartyId;
  /**
   * The admin (disclosure authority) party. In a custodian deployment
   * this typically equals `issuerParty`; in delegated-issuance setups
   * it may differ.
   */
  readonly adminParty: PartyId;
  /**
   * The credential's business payload — claim values + validity
   * window + metadata. Keys MUST use reverse-DNS namespacing per
   * CIP #204. The SDK does not validate semantic content.
   */
  readonly claims: Claims;
  /**
   * Optional template-level created-at timestamp (ISO 8601 with Z
   * suffix). Distinct from `claims.validFrom` — the former is the
   * mint time, the latter is the validity-window start.
   */
  readonly createdAt?: string;
  /**
   * Optional template-level expiry timestamp (ISO 8601 with Z
   * suffix). Distinct from `claims.validUntil` — applications may
   * choose to set both or only the in-claims one.
   */
  readonly expiresAt?: string;
  /**
   * Template-level non-business metadata. Independent of
   * `claims.meta`.
   */
  readonly meta?: Metadata;
}

/**
 * Result of a successful `createCredential()` call.
 */
export interface CreateCredentialResult {
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
  readonly completionOffset: LedgerOffset;
}

/**
 * Arguments accepted by `verifyCredential()`. Under CIP #204 the
 * standard choice is `Credential_PublicFetch`:
 *
 *     nonconsuming choice Credential_PublicFetch : CredentialView
 *       with
 *         expectedAdmin : Party
 *         actor         : Party
 *       controller actor
 *
 *   * `actor` is the verifier's party (controller). The participant
 *     authorises the call via the actor's namespace fingerprint.
 *   * `expectedAdmin` is the admin party the verifier expects. The
 *     implementer MUST `assertMsg expectedAdmin == (view this).admin`
 *     so a substituted credential is rejected at the choice body.
 *   * `disclosedBlobBase64` is attached when the verifier's
 *     participant does not have the contract in its local ACS
 *     (every cross-participant verify path). Canton authenticates
 *     the blob against the sequencer signature before the choice
 *     body runs.
 */
export interface VerifyCredentialInput {
  readonly contractId: ContractId;
  readonly actor: PartyId;
  readonly expectedAdmin: PartyId;
  readonly disclosedBlobBase64?: string;
}

/**
 * Result of a `verifyCredential()` call. `view` is the
 * `CredentialView` returned by the choice; lifecycle interpretation
 * (active vs. expired vs. revoked) is up to the caller.
 */
export interface VerifyCredentialResult {
  readonly view: CredentialView;
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
}

/**
 * Arguments accepted by `revokeCredential()`. `RevokeCredential` is
 * an implementer-side choice on `Canton.VC.Credential` (NOT part of
 * the CIP #204 standard surface) — issuer compliance revoke.
 * Cascade-burns the bound NFT atomically when present.
 */
export interface RevokeCredentialInput {
  readonly contractId: ContractId;
  readonly nftContractId?: ContractId;
  /**
   * Recorded on the revoked sibling's meta under the
   * `<implementer-namespace>/revoke.reason` key. Free-form string;
   * the template ensures it is non-empty.
   */
  readonly reason: string;
}

/**
 * Result of a `revokeCredential()` call.
 */
export interface RevokeCredentialResult {
  readonly contractId: ContractId;
  readonly commandId: CommandId;
  readonly updateId: UpdateId;
  readonly recordTime: string;
}

/**
 * Active contract returned by an ACS query.
 */
export interface ActiveContract {
  readonly contractId: ContractId;
  readonly templateId: TemplateId;
  readonly payload: CantonCredentialPayload;
  readonly signatories: readonly PartyId[];
  readonly observers: readonly PartyId[];
  readonly createdEventBlob: string | null;
}

/**
 * Result of a disclosure-style query.
 */
export interface DisclosureBundle {
  readonly contract: ActiveContract;
  readonly blobBase64: string;
  readonly fetchedAt: Date;
}

/* ---------- KycNFT (optional showcase companion template) ---------- */

/**
 * Arguments accepted by `createKycNft()`. The NFT is a soulbound
 * showcase token bound to a `Canton.VC.Credential` contract id. It
 * is NOT a CIP #204 surface — the standard interface does not require
 * a companion artefact. The template lives in the same DAML package
 * for convenience; consumers that do not need it can ignore the
 * helper.
 *
 * The template enforces its own preconditions at the chain boundary
 * (`level` value, non-empty fields). The SDK forwards string values
 * verbatim — what counts as a valid `level` is template-defined,
 * not SDK-defined.
 */
export interface CreateKycNftInput {
  readonly holderParty: PartyId;
  readonly boundCredentialId: ContractId;
  /**
   * The credential level being attested. The DAML template ensure
   * clause restricts the accepted set; the SDK treats it as opaque
   * text.
   */
  readonly level: string;
  readonly serialNumber: string;
  readonly displayName: string;
  /**
   * Inline `data:image/svg+xml;base64,…` URI. Consumers MUST
   * sanitise the SVG before encoding.
   */
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
 * DAML template fields 1:1.
 */
export interface KycNftPayload {
  readonly issuer: PartyId;
  readonly customer: PartyId;
  readonly boundCredentialId: ContractId;
  readonly issuedAt: string;
  readonly level: string;
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
}

/* ---------- Claim-key schema factory ---------- */

/**
 * Build a typed, frozen object of fully-qualified claim keys from a
 * single namespace + a list of short key names. Returns a
 * `Readonly<Record<K, string>>` where each value is `<namespace>/<k>`.
 *
 * Eliminates the boilerplate of writing per-key constants by hand
 * (and the silent-typo risk of repeating raw key strings at every
 * call site). One namespace change = all keys updated automatically.
 *
 * Per CIP #204 §"Namespacing" the namespace MUST be Java-style
 * reverse-DNS (`io.example`, `com.example.kyc`); the SDK does not
 * enforce the shape at runtime — applications choose their own.
 *
 * @example
 * ```ts
 * const KEYS = createClaimSchema('io.acme', ['level', 'userRef'] as const);
 * // KEYS.level === 'io.acme/level'
 * // KEYS.userRef === 'io.acme/userRef'
 * getClaim(view.claims, KEYS.level);
 * ```
 */
export function createClaimSchema<K extends string>(
  namespace: string,
  keys: readonly K[],
): Readonly<Record<K, string>> {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('createClaimSchema: namespace must be a non-empty string.');
  }
  const out = {} as Record<K, string>;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('createClaimSchema: every key must be a non-empty string.');
    }
    out[key] = `${namespace}/${key}`;
  }
  return Object.freeze(out);
}

/* ---------- Generic Claims accessors ---------- */

/**
 * Read a claim from a `Claims` value. Returns `undefined` when the
 * key is missing. Consumers compose their own namespaced wrappers
 * (e.g. via {@link createClaimSchema}) — the SDK does not opine on
 * any specific namespace.
 */
export function getClaim(claims: Claims, key: string): string | undefined {
  return claims.values[key];
}

/**
 * Read a boolean-encoded claim. Per CIP #204 all claim values are
 * text-encoded; `"true"` → `true`, `"false"` → `false`, anything
 * else → `undefined`.
 */
export function getBoolClaim(claims: Claims, key: string): boolean | undefined {
  const raw = claims.values[key];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * Read an integer-encoded claim. Returns `undefined` for missing or
 * non-numeric values.
 */
export function getIntClaim(claims: Claims, key: string): number | undefined {
  const raw = claims.values[key];
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * Check whether the credential is within its validity window. CIP
 * #204 does not define a "status" enum — lifecycle interpretation
 * (revoked vs. expired vs. active) is the implementer's choice. This
 * helper only checks the validity-window timestamps:
 *
 *   * `claims.validFrom` (if set) ≤ `now`
 *   * `claims.validUntil` (if set) ≥ `now`
 *   * `expiresAt` (if set) ≥ `now`
 *
 * Returns `true` when all set timestamps allow the credential, OR
 * when none are set (no window declared). Callers needing a
 * revocation check MUST consult their own status claim or query
 * the contract's activity state separately.
 */
export function isWithinValidityWindow(view: CredentialView, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  const isBeforeUpper = (iso: string | null): boolean => {
    if (iso === null) return true;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    return nowMs <= t;
  };
  const isAfterLower = (iso: string | null): boolean => {
    if (iso === null) return true;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    return nowMs >= t;
  };
  return (
    isAfterLower(view.claims.validFrom) &&
    isBeforeUpper(view.claims.validUntil) &&
    isBeforeUpper(view.expiresAt)
  );
}
