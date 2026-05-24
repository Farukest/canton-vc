/**
 * Pure command builders for the Canton V2 JSON Ledger API.
 *
 * These functions take a `CantonConfig` and a semantic input, and
 * return the exact JSON body we `POST` to
 * `/v2/commands/submit-and-wait-for-transaction`. They are *pure* —
 * no I/O, no randomness except the command id mint, no hidden state.
 *
 * The V2 API uses a nested wrapper shape:
 *
 *     {
 *       "commands": {
 *         "commandId": "<opaque>",
 *         "userId": "<our-user-id>",
 *         "actAs": ["<operator-party>"],
 *         "commands": [
 *           { "CreateCommand": { "templateId": "...", "createArguments": {...} } }
 *         ]
 *       },
 *       // optional transactionFormat for LEDGER_EFFECTS shape
 *     }
 *
 * The outer key is **also** called `commands` — yes, the same name at
 * two levels. This module wraps that gotcha inside the builder so the
 * call site never has to remember it.
 *
 * Command IDs are generated from a timestamp + 8 hex chars of random
 * entropy, prefixed by `config.commandIdPrefix`. That keeps them
 * uniformly short (~28 chars) while still collision-resistant enough
 * for the narrow deduplication window the participant enforces.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CantonConfig } from './config';
import { CantonError } from './errors';
import {
  type CommandId,
  type ContractId,
  type CreateCredentialInput,
  type CreateKycNftInput,
  type DamlCredentialStatus,
  type DamlKycLevel,
  type DamlValidatorType,
  DB_TO_DAML_LEVEL,
  DB_TO_DAML_STATUS,
  DB_TO_DAML_VALIDATOR,
  type PartyId,
  type RevokeCredentialInput,
  type VerifyCredentialInput,
} from './types';

/* ---------- Constants ---------- */

/**
 * Hard ceiling on generated command ids, independent of the config.
 * The V2 API accepts up to 256 chars but shorter is better for logs.
 * We stay well below by design — 8 random bytes + prefix + timestamp
 * is ~30 chars.
 */
export const MAX_COMMAND_ID_LENGTH = 64;

/**
 * Daml-side transaction shape constant for exercises where we care
 * about the choice return value. See `verifyCommandBody` below.
 */
export const TRANSACTION_SHAPE_LEDGER_EFFECTS = 'TRANSACTION_SHAPE_LEDGER_EFFECTS' as const;

/* ---------- Command id ---------- */

/**
 * Mint a fresh command id. Format:
 *
 *     <prefix>-<purpose>-<epochMs>-<8 hex chars>
 *
 * `purpose` is a short tag like `create`, `verify`, `revoke` that
 * makes participant logs easier to read. The timestamp + random
 * suffix ensures uniqueness within the deduplication window.
 *
 * Tests can override the random source by passing a deterministic
 * `rand` function; production uses `node:crypto.randomBytes`.
 */
export function newCommandId(
  config: CantonConfig,
  purpose: 'create' | 'verify' | 'revoke' | 'create-nft',
  clock: () => number = Date.now,
  rand: (n: number) => Buffer = randomBytes,
): CommandId {
  const timestamp = clock();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new CantonError(
      'invalid_command_id',
      `Invalid clock value ${String(timestamp)} when generating a command id.`,
    );
  }
  const randomHex = rand(4).toString('hex');
  const candidate = `${config.commandIdPrefix}-${purpose}-${timestamp}-${randomHex}`;
  if (candidate.length > MAX_COMMAND_ID_LENGTH) {
    throw new CantonError(
      'invalid_command_id',
      `Generated command id exceeds ${MAX_COMMAND_ID_LENGTH} chars: ${candidate}`,
    );
  }
  return candidate as CommandId;
}

/**
 * Mint a *deterministic* command id from a stable seed. Format:
 *
 *     <prefix>-<purpose>-<sha256(seed)[0..16]>
 *
 * Distinct from {@link newCommandId} (timestamp + random) — purpose
 * here is to opt **into** Canton's command-deduplication so a retry
 * of the same logical action (e.g. NFT mint for credential X)
 * resolves to the same submission rather than producing a duplicate
 * on-chain artefact.
 *
 * Daml Ledger API guarantees: within the participant's deduplication
 * window (`deduplication_period`), a second submit with the same
 * `(actAs, commandId)` returns `ALREADY_EXISTS` (the original tx
 * stays the canonical one — chain has exactly one event). The caller
 * MUST be ready to handle that error path; see `cantonFetch`'s
 * `command_already_submitted` error code.
 *
 * Use ONLY for actions that map 1:1 to a stable domain id (e.g.
 * `nft-mint:<credentialId>`). Never seed with timestamps or random
 * values — that defeats the point.
 */
export function deterministicCommandId(
  config: CantonConfig,
  purpose: 'create' | 'verify' | 'revoke' | 'create-nft',
  seed: string,
): CommandId {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new CantonError(
      'invalid_command_id',
      'deterministicCommandId: seed must be a non-empty string.',
    );
  }
  // 16 hex chars (64 bits) of sha256 prefix is collision-resistant
  // enough — domain seeds (e.g. UUID credentialIds) carry their own
  // entropy; we just want a fixed-width opaque tag.
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const candidate = `${config.commandIdPrefix}-${purpose}-${digest}`;
  if (candidate.length > MAX_COMMAND_ID_LENGTH) {
    throw new CantonError(
      'invalid_command_id',
      `Deterministic command id exceeds ${MAX_COMMAND_ID_LENGTH} chars: ${candidate}`,
    );
  }
  return candidate as CommandId;
}

/* ---------- Input validation helpers ---------- */

/**
 * Validate a proof hash: non-empty lowercase hex up to 128 chars.
 * Throws `CantonError('invalid_command', …)` on failure.
 */
function validateProofHash(proofHash: string): string {
  if (typeof proofHash !== 'string' || proofHash.length === 0) {
    throw new CantonError(
      'invalid_command',
      'createCredential: proofHash must be a non-empty string.',
    );
  }
  if (proofHash.length > 128) {
    throw new CantonError(
      'invalid_command',
      `createCredential: proofHash exceeds 128 chars (was ${proofHash.length}).`,
    );
  }
  if (!/^[0-9a-f]+$/i.test(proofHash)) {
    throw new CantonError('invalid_command', 'createCredential: proofHash must be a hex string.');
  }
  return proofHash.toLowerCase();
}

/**
 * Validate an ISO 8601 timestamp string (`YYYY-MM-DDTHH:MM:SS[.sss]Z`).
 * The Daml template stores `validUntil` as a `Time`, which Canton
 * serializes with a full time component. Sending a date-only string
 * (`YYYY-MM-DD`) would be rejected by the participant with a parser
 * error at index 10 — we catch the wrong shape here so the failure
 * surfaces at the command builder rather than as a 500 from the JSON
 * Ledger API.
 *
 * The regex accepts an optional fractional-second component up to
 * nanosecond precision (Daml-LF `Time` is microseconds, but JS
 * `Date.toISOString()` emits milliseconds and some external producers
 * emit nanoseconds — the participant tolerates both).
 */
function validateIsoDateTime(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    throw new CantonError(
      'invalid_command',
      `createCredential: ${field} must be an ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ), got "${value}".`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CantonError(
      'invalid_command',
      `createCredential: ${field} is not a real timestamp ("${value}").`,
    );
  }
  // Round-trip check: JS `Date` is lenient and silently rolls
  // impossible dates over (e.g. `2027-02-31T00:00:00Z` becomes
  // 2027-03-03). Compare the YYYY-MM-DDTHH:MM:SS prefix to catch the
  // mismatch before the value reaches the participant. Fractional
  // seconds and trailing `Z` are excluded from the comparison so
  // millisecond/nanosecond inputs still pass.
  const roundTripped = parsed.toISOString().slice(0, 19);
  if (roundTripped !== value.slice(0, 19)) {
    throw new CantonError(
      'invalid_command',
      `createCredential: ${field} does not round-trip ("${value}" → "${parsed.toISOString()}").`,
    );
  }
  return value;
}

/**
 * Validate a human score: 0..100 integer.
 */
function validateHumanScore(score: number): number {
  if (!Number.isFinite(score) || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new CantonError(
      'invalid_command',
      `createCredential: humanScore must be an integer between 0 and 100, got ${String(score)}.`,
    );
  }
  return score;
}

/**
 * Validate the firm-facing user reference. Daml `Text` accepts any
 * Unicode string but the template `ensure` clause rejects an
 * empty value, and the `kyc_sessions.user_ref` Postgres column caps
 * the value at 128 chars — match that ceiling here so a misconfigured
 * caller fails at the boundary rather than at the participant.
 */
function validateUserRef(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CantonError(
      'invalid_command',
      'createCredential: userRef must be a non-empty string.',
    );
  }
  if (raw.length > 128) {
    throw new CantonError(
      'invalid_command',
      `createCredential: userRef exceeds 128 chars (was ${raw.length}).`,
    );
  }
  return raw;
}

/**
 * Validate a contract id. Empty / non-string inputs fail fast.
 */
function validateContractId(raw: string, op: string): ContractId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CantonError('invalid_contract_id', `${op}: contractId must be a non-empty string.`);
  }
  if (raw.length > 8192) {
    throw new CantonError(
      'invalid_contract_id',
      `${op}: contractId exceeds 8192 chars (was ${raw.length}).`,
    );
  }
  return raw as ContractId;
}

/* ---------- Command body shapes ---------- */

/**
 * Outgoing shape of the `CreateCommand` inner object — matches the
 * Daml-LF JSON encoding. Using a precise interface means a drift in
 * the template forces a compile error downstream.
 *
 * `userRef` is part of the template payload — firms compare
 * the decoded blob's `userRef` against their internal record to
 * confirm the credential is bound to the user they expect.
 */
export interface CreateKycCredentialArguments {
  readonly operator: PartyId;
  readonly user: PartyId;
  readonly userRef: string;
  readonly proofHash: string;
  readonly status: DamlCredentialStatus;
  readonly level: DamlKycLevel;
  readonly validUntil: string;
  readonly network: string;
  readonly humanScore: number;
  readonly validator: DamlValidatorType;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  /**
   * v1.1.0 field. DAML `Optional Text` encodes on the wire as the
   * payload value or `null`. New mints under v1.1.0+ MUST set a
   * non-empty schema id; the template ensure clause rejects empty
   * strings and `null`.
   */
  readonly proofSchemaId: string;
}

/**
 * Disclosed-contract attachment shape for the V2 JSON Ledger API.
 * Used when the submitting participant does not have the target
 * contract in its local ACS — i.e. cross-firm verification where the
 * firm's participant has never observed the operator's mint. Canton
 * runs contract-authentication on the blob (sequencer signature +
 * contract-id hash recomputation) before the choice body executes,
 * so a tampered blob is rejected with
 * DISCLOSED_CONTRACT_AUTHENTICATION_FAILED.
 */
export interface DisclosedContract {
  readonly contractId: ContractId;
  readonly templateId: string;
  /** Base64 (or base64url) encoded `created_event_blob`. */
  readonly createdEventBlob: string;
  /** Optional. Pin the synchronizer when known. */
  readonly synchronizerId?: string;
}

/**
 * Outer shape of the `submit-and-wait-for-transaction` request body.
 * The V2 API requires the `commands` double wrapper — outer key is
 * the submission envelope, inner array is the command list.
 *
 * `disclosedContracts` is set when exercising on a contract the
 * submitting participant does not have in its local ACS (the
 * cross-firm `Verify` path). The contract is forwarded to the
 * participant verbatim and re-authenticated server-side.
 */
export interface SubmitAndWaitRequestBody {
  readonly commands: {
    readonly commandId: CommandId;
    readonly userId: string;
    readonly actAs: readonly PartyId[];
    readonly commands: readonly unknown[];
    readonly disclosedContracts?: readonly DisclosedContract[];
  };
  readonly transactionFormat?: {
    readonly transactionShape: typeof TRANSACTION_SHAPE_LEDGER_EFFECTS;
    readonly eventFormat: {
      readonly filtersForAnyParty: {
        readonly cumulative: readonly [
          {
            readonly identifierFilter: {
              readonly WildcardFilter: {
                readonly value: {
                  readonly includeCreatedEventBlob: false;
                };
              };
            };
          },
        ];
      };
      readonly verbose: true;
    };
  };
}

/* ---------- Builders ---------- */

/**
 * Common builder for the outer submission envelope. Wraps the inner
 * command list with the required `commands → { commands: [...] }`
 * double wrapper plus the act-as + user-id fields.
 */
function buildSubmissionEnvelope(
  config: CantonConfig,
  commandId: CommandId,
  actAs: PartyId,
  innerCommands: readonly unknown[],
  withLedgerEffects: boolean,
  disclosedContracts?: readonly DisclosedContract[],
): SubmitAndWaitRequestBody {
  const envelope: SubmitAndWaitRequestBody = {
    commands: {
      commandId,
      userId: config.userId,
      actAs: [actAs],
      commands: innerCommands,
      ...(disclosedContracts !== undefined && disclosedContracts.length > 0
        ? { disclosedContracts }
        : {}),
    },
    ...(withLedgerEffects
      ? {
          transactionFormat: {
            transactionShape: TRANSACTION_SHAPE_LEDGER_EFFECTS,
            eventFormat: {
              filtersForAnyParty: {
                cumulative: [
                  {
                    identifierFilter: {
                      WildcardFilter: {
                        value: {
                          includeCreatedEventBlob: false,
                        },
                      },
                    },
                  },
                ],
              },
              verbose: true,
            },
          },
        }
      : {}),
  };
  return envelope;
}

/**
 * Build the submission body for a `createCredential` call.
 *
 * Validates every field at the boundary so a bogus input from a
 * route handler fails with a meaningful error before touching the
 * network.
 */
export function buildCreateCredentialCommand(
  config: CantonConfig,
  input: CreateCredentialInput,
  operatorParty: PartyId,
  commandId: CommandId,
): SubmitAndWaitRequestBody {
  const userRef = validateUserRef(input.userRef);
  const proofHash = validateProofHash(input.proofHash);
  const validUntil = validateIsoDateTime(input.validUntil, 'validUntil');
  const humanScore = validateHumanScore(input.humanScore);

  const damlStatus = DB_TO_DAML_STATUS[input.status];
  const damlLevel = DB_TO_DAML_LEVEL[input.level];
  const damlValidator = DB_TO_DAML_VALIDATOR[input.validator];

  if (typeof input.proofSchemaId !== 'string' || input.proofSchemaId.length === 0) {
    throw new CantonError(
      'invalid_command',
      'createCredential: proofSchemaId is required on v1.1.0+ mints (Canton.VC.Credential ensure clause rejects empty/null).',
    );
  }
  const createArguments: CreateKycCredentialArguments = {
    operator: operatorParty,
    user: input.userParty,
    userRef,
    proofHash,
    status: damlStatus,
    level: damlLevel,
    validUntil,
    network: config.networkLabel,
    humanScore,
    validator: damlValidator,
    identityVerified: input.identityVerified,
    livenessVerified: input.livenessVerified,
    addressVerified: input.addressVerified,
    proofSchemaId: input.proofSchemaId,
  };

  const createCommand = {
    CreateCommand: {
      templateId: config.packageName,
      createArguments,
    },
  };

  return buildSubmissionEnvelope(config, commandId, operatorParty, [createCommand], false);
}

/**
 * Build the submission body for a `verifyCredential` call.
 *
 * The `Verify` choice is nonconsuming, takes
 * `with fetcher : Party`, has `controller fetcher`, and returns a
 * `CredentialView` struct. Two consequences for the command body:
 *
 *   * `actAs` is the fetcher (the choice controller), not the
 *     operator. The fetcher's participant is what authorises the
 *     submission against the network.
 *   * `disclosedContracts` is attached when the fetcher's participant
 *     does not have the contract in its local ACS — every cross-firm
 *     verify path. The operator-side self-verify call still works
 *     without a blob because the operator's own participant is the
 *     contract's signatory and already has it in the ACS.
 *
 * LEDGER_EFFECTS is requested so we get the
 * `ExercisedEvent.exerciseResult` (the struct view) back.
 *
 * `operatorParty` is unused for `actAs` here but is kept for API
 * symmetry with the create / revoke builders. The operator party
 * is the signatory of the contract and is observed implicitly via
 * the disclosed-contract authentication step.
 */
export function buildVerifyCredentialCommand(
  config: CantonConfig,
  input: VerifyCredentialInput,
  _operatorParty: PartyId,
  commandId: CommandId,
  /**
   * Resolved package-id form of `config.packageName` (e.g.
   * `<hash>:Module:Template`), required when attaching a
   * `DisclosedContract`. Canton's JSON Ledger v2 accepts the
   * `#name:Module:Template` package-name reference for
   * `ExerciseCommand.templateId` (the participant resolves names via
   * its local package store), but `DisclosedContract.templateId` is
   * strictly validated as `<lf-package-hash>:Module:Template` and
   * rejects the `#`-prefix with `Invalid value for: body
   * (non expected character 0x23 in Daml-LF Package ID …)`.
   *
   * Optional: when `input.disclosedBlobBase64` is absent (operator-
   * side self-verify path; the participant has the contract in its
   * ACS so no DisclosedContract is sent), this argument is unused
   * and can be omitted. When the blob IS provided and this is
   * unset, the builder falls back to `config.packageName` — which
   * works only if `packageName` is already in hash form.
   */
  disclosedTemplateId?: string,
): SubmitAndWaitRequestBody {
  const contractId = validateContractId(input.contractId, 'verifyCredential');

  const exerciseCommand = {
    ExerciseCommand: {
      templateId: config.packageName,
      contractId,
      choice: 'Verify',
      choiceArgument: { fetcher: input.fetcher },
    },
  };

  const disclosedContracts: readonly DisclosedContract[] | undefined =
    input.disclosedBlobBase64 !== undefined && input.disclosedBlobBase64.length > 0
      ? [
          {
            contractId,
            templateId: disclosedTemplateId ?? config.packageName,
            createdEventBlob: normalizeToStandardBase64(input.disclosedBlobBase64),
          },
        ]
      : undefined;

  return buildSubmissionEnvelope(
    config,
    commandId,
    input.fetcher,
    [exerciseCommand],
    true,
    disclosedContracts,
  );
}

/**
 * Convert a base64url-encoded blob (URL-safe alphabet with no padding)
 * to standard base64 (with `+`/`/` and `=` padding). Canton's JSON
 * Ledger v2 API strictly validates `createdEventBlob` as standard
 * base64 — passing base64url straight through is rejected with
 * `400 Invalid value for: body (The string is not a valid Base64: …)`.
 *
 * The SDK's OAuth surface (`apps/web/src/lib/credentials/view.ts`)
 * emits the credential blob in base64url so it round-trips
 * cleanly through URL parameters / JSON. This normaliser absorbs
 * that mismatch at the Canton wire seam: callers may pass either
 * encoding and we always send the participant what it expects.
 * Inputs that are already standard base64 round-trip unchanged.
 */
function normalizeToStandardBase64(s: string): string {
  const swapped = s.replace(/-/g, '+').replace(/_/g, '/');
  const padNeeded = (4 - (swapped.length % 4)) % 4;
  return padNeeded === 0 ? swapped : swapped + '='.repeat(padNeeded);
}

/**
 * Build the submission body for a `revokeCredential` call.
 *
 * v1.1.0 of the template added an `Optional (ContractId KycNFT)`
 * trailing parameter to the choice signature so the cascade burn of
 * the bound showcase NFT lands in the same Canton transaction as the
 * credential archive. The Daml choice body exercises `BurnNft` on
 * the supplied cid before re-creating the credential as
 * `status = "Revoked"`. Empty / missing nftCid is encoded as the
 * Daml `None` JSON shape (`{"tag": "None", "value": {}}` — historical
 * Canton convention; v2 JSON Ledger API also accepts `null` for
 * Optional fields).
 *
 * `RevokeCredential` is a consuming choice that returns
 * `ContractId KYCCredential` (the new sibling carrying status =
 * "Revoked"), so we don't need the ledger-effects shape — the
 * participant still confirms archival in the transaction events.
 */
export function buildRevokeCredentialCommand(
  config: CantonConfig,
  input: RevokeCredentialInput,
  operatorParty: PartyId,
  commandId: CommandId,
): SubmitAndWaitRequestBody {
  const contractId = validateContractId(input.contractId, 'revokeCredential');
  const nftCid =
    input.nftContractId !== undefined && input.nftContractId.length > 0
      ? validateContractId(input.nftContractId, 'revokeCredential.nftCid')
      : null;

  const exerciseCommand = {
    ExerciseCommand: {
      templateId: config.packageName,
      contractId,
      choice: 'RevokeCredential',
      choiceArgument: { nftCid },
    },
  };

  return buildSubmissionEnvelope(config, commandId, operatorParty, [exerciseCommand], false);
}

/* ---------- KycNFT (v1.1.0) ---------- */

/**
 * Outgoing shape of the NFT `CreateCommand` inner object — matches
 * the Daml-LF JSON encoding of the `KycNFT` template payload.
 */
export interface CreateKycNftArguments {
  readonly operator: PartyId;
  readonly customer: PartyId;
  readonly boundCredentialId: ContractId;
  readonly issuedAt: string;
  readonly level: 'Enhanced';
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
}

/**
 * Validate that `value` is a non-empty string, ≤ `max` chars.
 * Inline helper used by the NFT command builder for
 * `serialNumber`, `displayName`, `image` — all bounded by the
 * Daml ensure clause but capped at the boundary so a misconfigured
 * worker fails fast rather than at the participant.
 */
function validateBoundedNonEmpty(value: string, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CantonError('invalid_command', `createKycNft: ${field} must be a non-empty string.`);
  }
  if (value.length > max) {
    throw new CantonError(
      'invalid_command',
      `createKycNft: ${field} exceeds ${max} chars (was ${value.length}).`,
    );
  }
  return value;
}

/**
 * Build the submission body for a `createKycNft` call.
 *
 * The NFT is minted only after the bound `KYCCredential` has been
 * confirmed on chain — the worker passes the new credential's
 * contract id as `boundCredentialId`. The Daml ensure clause rejects
 * any `level != "Enhanced"` so a misconfigured caller fails at the
 * chain boundary; we additionally pin the same invariant here for
 * fail-fast diagnostics.
 *
 * `image` carries an inline `data:image/svg+xml;base64,…` URI. The
 * worker pre-sanitizes the SVG with DOMPurify before encoding; the
 * length cap (256 KiB raw, ~341 KB base64) is generous for a small
 * SVG showcase and below participant payload limits.
 */
export function buildCreateKycNftCommand(
  config: CantonConfig,
  input: CreateKycNftInput,
  operatorParty: PartyId,
  commandId: CommandId,
  clock: () => Date = () => new Date(),
): SubmitAndWaitRequestBody {
  if (input.level !== 'enhanced') {
    throw new CantonError(
      'invalid_command',
      `createKycNft: level must be "enhanced" (got "${String(input.level)}").`,
    );
  }
  const boundCredentialId = validateContractId(input.boundCredentialId, 'createKycNft');
  const serialNumber = validateBoundedNonEmpty(input.serialNumber, 64, 'serialNumber');
  const displayName = validateBoundedNonEmpty(input.displayName, 256, 'displayName');
  const image = validateBoundedNonEmpty(input.image, 350_000, 'image');
  const issuedAt = clock().toISOString();

  const createArguments: CreateKycNftArguments = {
    operator: operatorParty,
    customer: input.customerParty,
    boundCredentialId,
    issuedAt,
    level: 'Enhanced',
    serialNumber,
    displayName,
    image,
  };

  const createCommand = {
    CreateCommand: {
      // Same package as Credential — the NFT lives in the same
      // module, so the package-name reference resolves to both
      // templates.
      templateId: `${config.packageName.replace(/:Credential$/, '')}:KycNFT`,
      createArguments,
    },
  };

  return buildSubmissionEnvelope(config, commandId, operatorParty, [createCommand], false);
}
