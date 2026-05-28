/**
 * Zod schemas for the Canton V2 JSON Ledger API wire shapes.
 *
 * Every response the client receives from the participant is parsed
 * through one of these schemas before the value is handed to callers.
 * This catches:
 *
 *   * Silent shape drift after a Canton upgrade.
 *   * Participant-side bugs that return 200 with an unexpected body.
 *   * Accidental plaintext proxying of an HTML error page.
 *
 * The schemas validate exactly what we need and use `.passthrough()`
 * only where the participant legitimately attaches optional diagnostic
 * fields we don't want to reject.
 *
 * Credential payload mirrors the CIP #204 structural shape:
 * `issuer/holder/admin/claims/createdAt/expiresAt/meta`. Application
 * fields live inside `claims.values` under the application's chosen
 * reverse-DNS namespace per CIP #204 §"Namespacing". The
 * `CredentialView` returned by `Credential_PublicFetch` is byte-
 * identical to the template payload (it is the interface's
 * `viewtype`).
 */

import { z } from 'zod';

/* ---------- Primitives ---------- */

/**
 * Canton offset. Wire shape varies by endpoint and Canton version:
 * some endpoints return a JSON string, others a JSON integer. We
 * accept either and normalise to the canonical string form.
 */
const OffsetString = z
  .union([z.string().min(1).max(1024), z.number().int().nonnegative()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .pipe(z.string().min(1).max(1024));

/**
 * Party identifier string. We do structural validation (contains
 * `::`) in `party.ts`; at the schema level we accept any non-empty
 * bounded string.
 */
const PartyString = z.string().min(1).max(512);

/**
 * Contract id — participant format is a long hex string.
 */
const ContractIdString = z.string().min(1).max(8192);

/**
 * Template id — the package-qualified form `#pkg:Module:Template`.
 */
const TemplateIdString = z.string().min(1).max(1024);

/**
 * ISO 8601 datetime with a `Z` suffix. Participant emits UTC.
 */
const IsoDateTime = z.iso.datetime();

/**
 * Daml `Optional Time` → JSON. Encodes as the datetime string or
 * `null`. Used for `createdAt`, `expiresAt`, `claims.validFrom`,
 * `claims.validUntil`.
 */
const OptionalIsoDateTime = z.union([IsoDateTime, z.null()]);

/**
 * Base64 string (RFC 4648). Used for `createdEventBlob` and any
 * serialized Daml value we forward to firm participants.
 */
const Base64String = z
  .string()
  .min(1)
  .max(2_097_152) // 2 MiB cap
  .regex(/^[A-Za-z0-9+/=_-]+$/, {
    message: 'Must be a base64 (or base64url) encoded string.',
  });

/**
 * Daml `TextMap Text` on the wire — JSON object with string keys and
 * string values. Used for `claims.values`, `claims.meta`, and the
 * template `meta` field.
 */
const TextMapStringSchema = z.record(z.string().min(1).max(512), z.string().max(8192));

/* ---------- `/v2/parties/participant-id` (unchanged) ---------- */

export const ParticipantIdResponseSchema = z
  .object({ participantId: PartyString })
  .passthrough();

export type ParticipantIdResponse = z.infer<typeof ParticipantIdResponseSchema>;

/* ---------- `/v2/parties/{partyId}` (unchanged) ---------- */

const PartyDetailsSchema = z
  .object({
    party: PartyString,
    isLocal: z.boolean().optional(),
  })
  .passthrough();

export const PartyLookupResponseSchema = z
  .object({ partyDetails: z.array(PartyDetailsSchema) })
  .passthrough();

export type PartyLookupResponse = z.infer<typeof PartyLookupResponseSchema>;

export const PartyAllocationResponseSchema = z
  .object({ partyDetails: PartyDetailsSchema })
  .passthrough();

export type PartyAllocationResponse = z.infer<typeof PartyAllocationResponseSchema>;

/* ---------- `/v2/state/ledger-end` (unchanged) ---------- */

export const LedgerEndResponseSchema = z
  .object({ offset: OffsetString })
  .passthrough();

export type LedgerEndResponse = z.infer<typeof LedgerEndResponseSchema>;

/* ---------- CIP #204 `Claims` payload ---------- */

/**
 * On-wire shape of the Daml `Claims` record. Mirrors
 * `Cip204.Standard.Claims` 1:1.
 *
 *   * `values` — TextMap of `<namespace>/<property>` → text.
 *     Consumers read individual entries via `getClaim` after the
 *     schema has validated the overall shape.
 *   * `validFrom` / `validUntil` — Optional Time on chain; `null` or
 *     ISO datetime on the wire.
 *   * `meta` — TextMap for non-business metadata.
 */
const ClaimsSchema = z
  .object({
    values: TextMapStringSchema,
    validFrom: OptionalIsoDateTime,
    validUntil: OptionalIsoDateTime,
    meta: TextMapStringSchema,
  })
  .passthrough();

export type ClaimsWire = z.infer<typeof ClaimsSchema>;

/* ---------- `Canton.VC.Credential` template payload (v2.0.0) ---------- */

/**
 * On-wire shape of the `Canton.VC.Credential` template payload —
 * the CIP #204 structural shape. Application-specific claim values
 * live inside `claims.values` under the application's reverse-DNS
 * namespace; the SDK does not opine on naming.
 *
 *   * `issuer` / `holder` — joint signatories per CIP #204.
 *   * `admin` — disclosure authority (equals `issuer` in custodian
 *     deployments).
 *   * `claims` — see `ClaimsSchema`.
 *   * `createdAt` / `expiresAt` — Optional Time.
 *   * `meta` — TextMap for non-business metadata.
 */
const CantonCredentialPayloadSchema = z
  .object({
    issuer: PartyString,
    holder: PartyString,
    admin: PartyString,
    claims: ClaimsSchema,
    createdAt: OptionalIsoDateTime,
    expiresAt: OptionalIsoDateTime,
    meta: TextMapStringSchema,
  })
  .passthrough();

export type CantonCredentialPayloadWire = z.infer<typeof CantonCredentialPayloadSchema>;

/**
 * Re-parse a `createArgument` value as a `Canton.VC.Credential`
 * payload. Used by `query.ts::hydrateActiveContract` once the ACS
 * query has filtered to credential templateIds. Throws on shape
 * drift.
 */
export function parseCredentialPayload(raw: unknown): CantonCredentialPayloadWire {
  return CantonCredentialPayloadSchema.parse(raw);
}

/**
 * On-wire shape of the `CredentialView` returned by
 * `Credential_PublicFetch`. Identical to the template payload (the
 * `viewtype` of the interface is `CredentialView` which mirrors
 * the template fields).
 *
 * CIP #204 does not define an `isActive` flag. Lifecycle
 * interpretation (active vs. expired vs. revoked) is implementer-
 * defined; applications evaluate it client-side from `expiresAt`
 * and any status claim they choose to encode under their own
 * namespace.
 */
export const CredentialViewSchema = CantonCredentialPayloadSchema;

export type CredentialViewWire = z.infer<typeof CredentialViewSchema>;

/**
 * On-wire shape of the CIP #204 `Credential_ArchiveAsHolderResult`
 * record returned by the `Credential_ArchiveAsHolder` interface choice:
 * the now-archived view plus the caller-supplied metadata.
 */
export const ArchiveAsHolderResultSchema = z
  .object({
    archivedCredential: CredentialViewSchema,
    meta: TextMapStringSchema,
  })
  .passthrough();

export type ArchiveAsHolderResultWire = z.infer<typeof ArchiveAsHolderResultSchema>;

/* ---------- `KycNFT` payload (optional companion template) ---------- */

/**
 * On-wire shape of `Canton.VC.Credential.KycNFT`. Optional soulbound
 * companion template — NOT part of CIP #204. `level` is application-
 * defined (the DAML template ensure clause only checks non-empty).
 */
const KycNftPayloadSchema = z
  .object({
    issuer: PartyString,
    customer: PartyString,
    boundCredentialId: ContractIdString,
    issuedAt: IsoDateTime,
    level: z.string().min(1).max(64),
    serialNumber: z.string().min(1).max(64),
    displayName: z.string().min(1).max(256),
    image: z.string().min(1).max(350_000),
  })
  .passthrough();

export type KycNftPayloadWire = z.infer<typeof KycNftPayloadSchema>;

export function parseKycNftPayload(value: unknown): KycNftPayloadWire {
  return KycNftPayloadSchema.parse(value);
}

/* ---------- Created / Exercised events (mostly unchanged) ---------- */

/**
 * `CreatedEvent` as returned inside a transaction or an ACS entry.
 * `createArgument` stays `z.unknown()` so the same shape works for
 * `Credential` and `KycNFT` mints. Template-specific parsers
 * (`parseCredentialPayload`, `parseKycNftPayload`) re-parse
 * downstream.
 */
const CreatedEventSchema = z
  .object({
    contractId: ContractIdString,
    templateId: TemplateIdString,
    createArgument: z.unknown(),
    createdEventBlob: z.union([Base64String, z.literal('')]).optional(),
    signatories: z.array(PartyString).optional(),
    observers: z.array(PartyString).optional(),
  })
  .passthrough();

export type CreatedEventWire = z.infer<typeof CreatedEventSchema>;

/**
 * `ExercisedEvent` — returned when we exercise a choice with the
 * `TRANSACTION_SHAPE_LEDGER_EFFECTS` shape set. `exerciseResult` is
 * the choice return value. For `Credential_PublicFetch` it is the
 * full `CredentialView` struct (re-parsed via `CredentialViewSchema`
 * downstream); for `RevokeCredential` it is a new contract id;
 * for consuming-only choices it is the Daml `Unit` (`{}`).
 */
const ExercisedEventSchema = z
  .object({
    contractId: ContractIdString,
    templateId: TemplateIdString,
    choice: z.string().min(1).max(256),
    consuming: z.boolean().optional(),
    exerciseResult: z.unknown().optional(),
  })
  .passthrough();

export type ExercisedEventWire = z.infer<typeof ExercisedEventSchema>;

/**
 * A transaction event as it appears inside `transaction.events[]`.
 */
const TransactionEventSchema = z
  .object({
    CreatedEvent: CreatedEventSchema.optional(),
    ExercisedEvent: ExercisedEventSchema.optional(),
  })
  .passthrough();

export type TransactionEventWire = z.infer<typeof TransactionEventSchema>;

/* ---------- `/v2/commands/submit-and-wait-for-transaction` (unchanged) ---------- */

const TransactionSchema = z
  .object({
    updateId: z.string().min(1).max(1024),
    recordTime: IsoDateTime,
    offset: OffsetString,
    workflowId: z.string().max(1024).optional(),
    events: z.array(TransactionEventSchema),
  })
  .passthrough();

export const SubmitAndWaitResponseSchema = z
  .object({ transaction: TransactionSchema })
  .passthrough();

export type SubmitAndWaitResponse = z.infer<typeof SubmitAndWaitResponseSchema>;

/* ---------- `/v2/state/active-contracts` (unchanged) ---------- */

const ActiveContractEntrySchema = z
  .object({
    contractEntry: z
      .object({
        JsActiveContract: z
          .object({
            createdEvent: CreatedEventSchema,
            synchronizerId: z.string().optional(),
            reassignmentCounter: z
              .union([z.number(), z.string().regex(/^-?\d+$/)])
              .transform((v) => (typeof v === 'string' ? Number(v) : v))
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ActiveContractEntryWire = z.infer<typeof ActiveContractEntrySchema>;

export const ActiveContractsResponseSchema = z.array(ActiveContractEntrySchema);

export type ActiveContractsResponse = z.infer<typeof ActiveContractsResponseSchema>;

/* ---------- Error body (unchanged) ---------- */

export const CantonApiErrorSchema = z
  .object({
    cause: z.string().optional(),
    code: z.string().optional(),
    errorCategory: z.number().optional(),
    grpcCodeValue: z.number().optional(),
    correlationId: z.string().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type CantonApiError = z.infer<typeof CantonApiErrorSchema>;
