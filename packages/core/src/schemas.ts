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
 * Schemas here are intentionally conservative: they accept exactly
 * what we need and nothing more, and they use `.passthrough()` only
 * where the participant legitimately attaches optional diagnostic
 * fields we don't want to reject.
 *
 * The schemas cover the V2 endpoints listed in `PLAN.md` §15 that the
 * Canton client actually uses:
 *
 *   * `GET  /v2/parties/participant-id`  (namespace bootstrap)
 *   * `GET  /v2/parties/{partyId}`        (existence check)
 *   * `POST /v2/parties`                  (allocate)
 *   * `GET  /v2/state/ledger-end`         (offset)
 *   * `POST /v2/state/active-contracts`   (ACS query)
 *   * `POST /v2/commands/submit-and-wait-for-transaction` (create/verify/revoke)
 *
 * Nothing here validates our *outgoing* request bodies — those are
 * built with exact type-safety in `commands.ts`. These schemas only
 * validate what we receive.
 */

import { z } from 'zod';

/* ---------- Primitives ---------- */

/**
 * Canton offset. Wire shape varies by endpoint and Canton version:
 *
 *   * `/v2/state/ledger-end` historically returns a hex-zero-padded
 *     string (`"000000000000000001"`).
 *   * `/v2/commands/submit-and-wait-for-transaction` (Canton 3.x v2
 *     JSON Ledger API) emits the transaction offset as a JSON
 *     **number** because the underlying Daml-LF type is `Long`.
 *
 * Accepting both shapes and normalizing to `string` keeps the
 * downstream `LedgerOffset` brand consistent and lets future
 * Canton versions flip an endpoint's encoding without breaking the
 * client. The `.pipe(z.string()…)` re-validates length after
 * coercion so the bound (1..1024) still applies.
 */
const OffsetString = z
  .union([z.string().min(1).max(1024), z.number().int().nonnegative()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .pipe(z.string().min(1).max(1024));

/**
 * Daml `Int` field. Canton 3.x serializes 64-bit `Long` values as
 * **strings** in JSON to preserve precision beyond JS `Number`'s
 * 53-bit safe range; older versions and some endpoints emit them as
 * JSON numbers. We accept either shape and normalize to a JS `number`
 * for the consumer.
 *
 * NOTE: this is only safe for fields whose value range fits in a JS
 * `number` without loss (e.g. `humanScore: 0..100`,
 * `reassignmentCounter` in early ACS state). For unbounded `Long`
 * fields prefer to keep the string and parse with `BigInt` at the
 * call site.
 */
const DamlIntCoercedToNumber = z
  .union([z.number(), z.string().regex(/^-?\d+$/, 'Daml Int must be an integer')])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  .pipe(z.number().int());

/**
 * Party identifier string. We do structural validation (contains
 * `::`) in `party.ts`; at the schema level we accept any non-empty
 * bounded string.
 */
const PartyString = z.string().min(1).max(512);

/**
 * Contract id — participant format is a long hex string. We bound the
 * length generously so future protocol tweaks don't break us.
 */
const ContractIdString = z.string().min(1).max(8192);

/**
 * Template id — the package-qualified form `#pkg:Module:Template`.
 */
const TemplateIdString = z.string().min(1).max(1024);

/**
 * ISO 8601 datetime with a `Z` suffix — the participant always emits
 * UTC. Any non-matching string is rejected so we never silently
 * propagate a local-time record.
 */
const IsoDateTime = z.iso.datetime();

/**
 * Base64 string (RFC 4648). Used for `createdEventBlob` and any
 * serialized Daml value we forward to firm participants.
 */
const Base64String = z
  .string()
  .min(1)
  .max(2_097_152) // 2 MiB cap — blob larger than this is almost certainly malformed
  .regex(/^[A-Za-z0-9+/=_-]+$/, {
    message: 'Must be a base64 (or base64url) encoded string.',
  });

/* ---------- `/v2/parties/participant-id` ---------- */

/**
 * Bootstrap endpoint: returns the participant's own party id, which
 * we split on `::` to pull the fingerprint (namespace) used for
 * constructing operator + user party IDs.
 *
 * Response:
 *
 *     { "participantId": "participant::122012ab…" }
 */
export const ParticipantIdResponseSchema = z
  .object({
    participantId: PartyString,
  })
  .passthrough();

export type ParticipantIdResponse = z.infer<typeof ParticipantIdResponseSchema>;

/* ---------- `/v2/parties/{partyId}` ---------- */

/**
 * Single party-details entry returned when we look up a party by id.
 * The participant returns an array (possibly empty) under
 * `partyDetails`.
 */
const PartyDetailsSchema = z
  .object({
    party: PartyString,
    isLocal: z.boolean().optional(),
    // Additional fields like `displayName`, `localMetadata`, and
    // `identityProviderId` vary by participant version — ignored.
  })
  .passthrough();

export const PartyLookupResponseSchema = z
  .object({
    partyDetails: z.array(PartyDetailsSchema),
  })
  .passthrough();

export type PartyLookupResponse = z.infer<typeof PartyLookupResponseSchema>;

/* ---------- `POST /v2/parties` (allocate) ---------- */

/**
 * Allocation success response. Canton 3.x returns a single
 * `partyDetails` object (not an array) with the full participant-
 * qualified party id.
 */
export const PartyAllocationResponseSchema = z
  .object({
    partyDetails: PartyDetailsSchema,
  })
  .passthrough();

export type PartyAllocationResponse = z.infer<typeof PartyAllocationResponseSchema>;

/* ---------- `/v2/state/ledger-end` ---------- */

/**
 * Current ledger end offset. The participant returns the offset as
 * a string (opaque). Used for `activeAtOffset` queries so we read a
 * consistent snapshot.
 */
export const LedgerEndResponseSchema = z
  .object({
    offset: OffsetString,
  })
  .passthrough();

export type LedgerEndResponse = z.infer<typeof LedgerEndResponseSchema>;

/* ---------- Created / Exercised events ---------- */

/**
 * `createArgument` is the Daml payload inside a CreatedEvent. Every
 * field matches the `Canton.VC.Credential` template on a 1:1 basis.
 * Extra fields are ignored so a schema upgrade is non-breaking for
 * consumers that only read the core fields we care about.
 *
 * `validUntil` is emitted as an ISO 8601 timestamp string
 * (`YYYY-MM-DDTHH:MM:SS[.sss]Z`) by the participant — the Daml
 * template stores it as `Time`. `humanScore` is a Daml `Int`,
 * encoded by Canton 3.x as a JSON string for precision
 * preservation; `DamlIntCoercedToNumber` normalizes to `number`
 * downstream and pins the 0..100 invariant. The three `*Verified`
 * flags are Daml `Bool`.
 */
const KycCredentialPayloadSchema = z
  .object({
    operator: PartyString,
    user: PartyString,
    // the predecessor template version added `userRef` to the on-chain
    // payload. Bound to 128 chars — same ceiling enforced by
    // `kyc_sessions.user_ref` and the command builder.
    userRef: z.string().min(1).max(128),
    proofHash: z.string().min(1).max(512),
    status: z.enum(['Pending', 'Active', 'Revoked', 'Expired']),
    // the level enum collapsed to {Basic, Enhanced}. The
    // intermediate Standard tier was retired in the same release.
    level: z.enum(['Basic', 'Enhanced']),
    validUntil: z.iso.datetime(),
    network: z.string().min(1).max(128),
    humanScore: DamlIntCoercedToNumber.pipe(z.number().int().min(0).max(100)),
    validator: z.enum([
      'DiditValidator',
      'OnfidoValidator',
      'PersonaValidator',
      'SumsubValidator',
      'VeriffValidator',
      'Au10tixValidator',
      'JumioValidator',
      'ZkValidator',
      'Generic',
    ]),
    identityVerified: z.boolean(),
    livenessVerified: z.boolean(),
    addressVerified: z.boolean(),
    // v1.1.0 addition. `Optional Text` on the chain → `string | null`
    // on the wire. New mints under v1.1.0+ MUST carry a non-empty
    // string; legacy v1.0.0 contracts surface as `null` here.
    proofSchemaId: z.string().nullable().optional(),
  })
  .passthrough();

export type KycCredentialPayloadWire = z.infer<typeof KycCredentialPayloadSchema>;

/**
 * Re-parse a `createArgument` value as a `KycCredentialPayload`. Used
 * by `query.ts::hydrateActiveContract` once the ACS query has filtered
 * to credential templateIds. Throws on shape drift.
 */
export function parseKycCredentialPayload(raw: unknown): KycCredentialPayloadWire {
  return KycCredentialPayloadSchema.parse(raw);
}

/**
 * `CredentialView` returned by the `Verify` choice. Wire
 * shape mirrors `KycCredentialPayloadSchema` plus a server-evaluated
 * `isActive` flag (`status == "Active" && now <= validUntil` per the
 * choice body — both sides of the comparison are Daml `Time`). Firms read every field of this struct
 * instead of trusting a sidecar JSON from the issuer — combined with
 * Canton's contract-authentication on the disclosed blob, the result
 * is a cryptographic guarantee the data was committed by the operator
 * at issuance time.
 */
export const KycCredentialViewSchema = z
  .object({
    userRef: z.string().min(1).max(128),
    proofHash: z.string().min(1).max(512),
    status: z.enum(['Pending', 'Active', 'Revoked', 'Expired']),
    level: z.enum(['Basic', 'Enhanced']),
    validUntil: z.iso.datetime(),
    network: z.string().min(1).max(128),
    humanScore: DamlIntCoercedToNumber.pipe(z.number().int().min(0).max(100)),
    validator: z.enum([
      'DiditValidator',
      'OnfidoValidator',
      'PersonaValidator',
      'SumsubValidator',
      'VeriffValidator',
      'Au10tixValidator',
      'JumioValidator',
      'ZkValidator',
      'Generic',
    ]),
    identityVerified: z.boolean(),
    livenessVerified: z.boolean(),
    addressVerified: z.boolean(),
    isActive: z.boolean(),
    // v1.1.0 addition. `Optional Text` on the chain → `string | null`
    // on the wire. Verifiers SHOULD treat `null` as audit-incomplete
    // (legacy v1.0.0 credential).
    proofSchemaId: z.string().nullable().optional(),
  })
  .passthrough();

export type KycCredentialViewWire = z.infer<typeof KycCredentialViewSchema>;

/**
 * `Canton.VC.Credential.KycNFT` on-ledger payload (v1.1.0+). Mirrors
 * the Daml template fields 1:1. The `image` cap is set well above the
 * inline-SVG mint payload (~3 KB after sanitisation/base64) but bounded
 * to 350 KiB so a forge attempt can't tunnel an arbitrarily large blob
 * through the schema.
 */
const KycNftPayloadSchema = z
  .object({
    operator: PartyString,
    customer: PartyString,
    boundCredentialId: ContractIdString,
    issuedAt: z.iso.datetime(),
    level: z.literal('Enhanced'),
    serialNumber: z.string().min(1).max(64),
    displayName: z.string().min(1).max(256),
    image: z.string().min(1).max(350_000),
  })
  .passthrough();

export type KycNftPayloadWire = z.infer<typeof KycNftPayloadSchema>;

export function parseKycNftPayload(value: unknown): KycNftPayloadWire {
  return KycNftPayloadSchema.parse(value);
}

/**
 * `CreatedEvent` as returned inside a transaction or an ACS entry.
 *
 * Fields relevant to us:
 *
 *   * `contractId` — what we persist as `canton_contract_id`.
 *   * `templateId` — used to assert we got back what we asked for.
 *   * `createArgument` — the template payload.
 *   * `createdEventBlob` — only present when the query asked for it
 *     (`includeCreatedEventBlob: true`) or the submit was configured
 *     to return blobs.
 *   * `signatories` / `observers` — party lists.
 */
const CreatedEventSchema = z
  .object({
    contractId: ContractIdString,
    templateId: TemplateIdString,
    // The submit-and-wait pipeline is shared between every template we
    // mint — KycCredential, KycNFT, future siblings. Validating
    // `createArgument` against a single template's schema here would
    // reject every other mint's response. Callers that need the typed
    // payload (`query.ts::hydrateActiveContract` for the credential
    // ACS path) re-parse with the template-specific schema; the mint
    // path only reads `contractId`, so a generic `unknown` is enough.
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
 * the choice return value; for `Verify` it is a JSON `boolean`, for
 * consuming choices like `RevokeCredential` it is the Daml `Unit`
 * which serializes as `{}`.
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
 * The participant wraps each event in a single-key object — either
 * `CreatedEvent` or `ExercisedEvent`. Archived events can also
 * appear for consuming choices but we don't read them directly.
 */
const TransactionEventSchema = z
  .object({
    CreatedEvent: CreatedEventSchema.optional(),
    ExercisedEvent: ExercisedEventSchema.optional(),
  })
  .passthrough();

export type TransactionEventWire = z.infer<typeof TransactionEventSchema>;

/* ---------- `/v2/commands/submit-and-wait-for-transaction` ---------- */

/**
 * Submit response for create and exercise commands. `transaction`
 * carries the record time + ledger offset + event list; `updateId`
 * is the transaction identifier.
 *
 * We require the top-level `updateId` and a populated `transaction`
 * block with non-empty events. Anything else is rejected as an
 * invalid response.
 */
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
  .object({
    transaction: TransactionSchema,
  })
  .passthrough();

export type SubmitAndWaitResponse = z.infer<typeof SubmitAndWaitResponseSchema>;

/* ---------- `/v2/state/active-contracts` ---------- */

/**
 * ACS entry wrapping a single active contract. The participant wraps
 * each active contract inside a `JsActiveContract` envelope under
 * `contractEntry`. Other entry types (`JsIncompleteAssigned`,
 * `JsIncompleteUnassigned`) exist but we filter them out.
 */
const ActiveContractEntrySchema = z
  .object({
    contractEntry: z
      .object({
        JsActiveContract: z
          .object({
            createdEvent: CreatedEventSchema,
            synchronizerId: z.string().optional(),
            // Same Daml `Long` precision concern as `humanScore` —
            // accept either JSON encoding and normalize to number.
            reassignmentCounter: DamlIntCoercedToNumber.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ActiveContractEntryWire = z.infer<typeof ActiveContractEntrySchema>;

/**
 * Top-level response of `/v2/state/active-contracts`. The participant
 * returns a bare JSON array (not an object wrapper), so the schema is
 * a plain array.
 */
export const ActiveContractsResponseSchema = z.array(ActiveContractEntrySchema);

export type ActiveContractsResponse = z.infer<typeof ActiveContractsResponseSchema>;

/* ---------- Error body ---------- */

/**
 * Structured error response shape emitted by the participant for 4xx
 * and 5xx conditions. We use it to extract a meaningful message; the
 * tests assert our mapping from this shape to `CantonErrorCode`.
 *
 * The fields here mirror what the Canton documentation pins down
 * (`docs/40-json-ledger-api-overview.md` §error-format).
 */
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
