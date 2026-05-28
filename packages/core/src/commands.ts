/**
 * Pure command builders for the Canton V2 JSON Ledger API — v2.0.0.
 *
 * These functions take a `CantonConfig` and a semantic input, and
 * return the exact JSON body we `POST` to
 * `/v2/commands/submit-and-wait-for-transaction`. They are pure:
 * no I/O, no randomness except the command id mint, no hidden state.
 *
 * The V2 API uses a nested wrapper shape:
 *
 *     {
 *       "commands": {
 *         "commandId": "<opaque>",
 *         "userId": "<our-user-id>",
 *         "actAs": ["<party-1>", "<party-2>", ...],
 *         "commands": [
 *           { "CreateCommand": { "templateId": "...", "createArguments": {...} } }
 *         ]
 *       }
 *     }
 *
 * v2.0.0 SHAPE CHANGES (CIP #204 alignment):
 *
 *   * Create: joint signatory (issuer + holder). `actAs` carries
 *     both parties — both must be hosted on the submitting
 *     participant (custodian model). Cross-participant flows
 *     require a propose-accept layer above this API.
 *
 *   * Verify: exercises `Credential_PublicFetch` on the
 *     `Canton.VC.Credential` template (which inherits the choice
 *     from the `Cip204.Standard.Credential` interface). The choice
 *     takes `expectedAdmin` + `actor` and returns the
 *     `CredentialView` view; the implementer-side assertion
 *     `expectedAdmin == admin` is enforced inside the choice body.
 *
 *   * Revoke: implementer-specific choice — preserved from v1.1.0
 *     surface area. NOT part of CIP #204.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CantonConfig } from './config';
import { CantonError } from './errors';
import type {
  Claims,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateKycNftInput,
  Metadata,
  PartyId,
  RevokeCredentialInput,
  VerifyCredentialInput,
} from './types';

/* ---------- Constants ---------- */

export const MAX_COMMAND_ID_LENGTH = 64;

export const TRANSACTION_SHAPE_LEDGER_EFFECTS = 'TRANSACTION_SHAPE_LEDGER_EFFECTS' as const;

/* ---------- Command id ---------- */

/**
 * Mint a fresh command id. Format:
 *
 *     <prefix>-<purpose>-<epochMs>-<8 hex chars>
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
 * Mint a deterministic command id from a stable seed. Use ONLY for
 * actions that map 1:1 to a stable domain id — never seed with
 * timestamps or random values.
 *
 * Daml Ledger API guarantees: within the participant's deduplication
 * window, a second submit with the same `(actAs, commandId)` returns
 * `ALREADY_EXISTS` and the original tx stays canonical. Callers MUST
 * be ready to handle that error path.
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
 * Validate an ISO 8601 timestamp string. Used for `createdAt`,
 * `expiresAt`, `claims.validFrom`, `claims.validUntil`.
 *
 * Round-trips through `Date.toISOString()` to catch impossible
 * calendar dates (`2027-02-31` silently rolls over in JS).
 */
function validateIsoDateTime(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    throw new CantonError(
      'invalid_command',
      `${field} must be an ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ), got "${value}".`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CantonError(
      'invalid_command',
      `${field} is not a real timestamp ("${value}").`,
    );
  }
  const roundTripped = parsed.toISOString().slice(0, 19);
  if (roundTripped !== value.slice(0, 19)) {
    throw new CantonError(
      'invalid_command',
      `${field} does not round-trip ("${value}" → "${parsed.toISOString()}").`,
    );
  }
  return value;
}

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

function validateParty(raw: string, field: string): PartyId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CantonError('invalid_command', `${field} must be a non-empty party id.`);
  }
  if (raw.length > 512) {
    throw new CantonError(
      'invalid_command',
      `${field} exceeds 512 chars (was ${raw.length}).`,
    );
  }
  return raw as PartyId;
}

function validateClaims(claims: Claims): Claims {
  if (typeof claims !== 'object' || claims === null) {
    throw new CantonError('invalid_command', 'claims must be a Claims object.');
  }
  if (typeof claims.values !== 'object' || claims.values === null) {
    throw new CantonError('invalid_command', 'claims.values must be a TextMap.');
  }
  if (Object.keys(claims.values).length === 0) {
    throw new CantonError(
      'invalid_command',
      'claims.values must contain at least one entry — the template ensure clause rejects an empty claim map.',
    );
  }
  for (const [k, v] of Object.entries(claims.values)) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new CantonError('invalid_command', 'claims.values: key must be a non-empty string.');
    }
    if (typeof v !== 'string') {
      throw new CantonError(
        'invalid_command',
        `claims.values["${k}"]: value must be a string (got ${typeof v}).`,
      );
    }
  }
  if (claims.validFrom !== null && claims.validFrom !== undefined) {
    validateIsoDateTime(claims.validFrom, 'claims.validFrom');
  }
  if (claims.validUntil !== null && claims.validUntil !== undefined) {
    validateIsoDateTime(claims.validUntil, 'claims.validUntil');
  }
  return claims;
}

/* ---------- Command body shapes ---------- */

/**
 * Outgoing shape of the CIP #204 `Claims` record on the wire.
 * `validFrom`/`validUntil` encode as ISO datetime string or
 * `null` (Daml `Optional Time`).
 */
interface ClaimsWire {
  readonly values: Readonly<Record<string, string>>;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly meta: Metadata;
}

/**
 * Outgoing shape of the `CreateCommand` inner object — mirrors the
 * Daml-LF JSON encoding of the `Canton.VC.Credential` v2.0.0
 * template payload.
 */
export interface CreateCredentialArguments {
  readonly issuer: PartyId;
  readonly holder: PartyId;
  readonly admin: PartyId;
  readonly claims: ClaimsWire;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly meta: Metadata;
}

/**
 * Disclosed-contract attachment shape for the V2 JSON Ledger API.
 * Used when the submitting participant does not have the target
 * contract in its local ACS — i.e. cross-participant verification.
 * Canton runs contract-authentication on the blob (sequencer
 * signature + contract-id hash recomputation) before the choice
 * body executes.
 */
export interface DisclosedContract {
  readonly contractId: ContractId;
  readonly templateId: string;
  readonly createdEventBlob: string;
  readonly synchronizerId?: string;
}

/**
 * Outer shape of the `submit-and-wait-for-transaction` request body.
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

function buildSubmissionEnvelope(
  config: CantonConfig,
  commandId: CommandId,
  actAs: readonly PartyId[],
  innerCommands: readonly unknown[],
  withLedgerEffects: boolean,
  disclosedContracts?: readonly DisclosedContract[],
): SubmitAndWaitRequestBody {
  return {
    commands: {
      commandId,
      userId: config.userId,
      actAs,
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
}

/**
 * Convert a `Claims` value into its on-wire shape. `validFrom` /
 * `validUntil` undefined → null (Daml `None`).
 */
function claimsToWire(claims: Claims): ClaimsWire {
  return {
    values: claims.values,
    validFrom: claims.validFrom ?? null,
    validUntil: claims.validUntil ?? null,
    meta: claims.meta ?? {},
  };
}

/**
 * Build the submission body for a `createCredential` call.
 *
 * Joint signatory: `actAs` carries both issuer and holder. Both
 * must be hosted on the submitting participant.
 */
export function buildCreateCredentialCommand(
  config: CantonConfig,
  input: CreateCredentialInput,
  commandId: CommandId,
): SubmitAndWaitRequestBody {
  const issuer = validateParty(input.issuerParty, 'issuerParty');
  const holder = validateParty(input.holderParty, 'holderParty');
  const admin = validateParty(input.adminParty, 'adminParty');
  const claims = validateClaims(input.claims);
  const createdAt = input.createdAt !== undefined
    ? validateIsoDateTime(input.createdAt, 'createdAt')
    : null;
  const expiresAt = input.expiresAt !== undefined
    ? validateIsoDateTime(input.expiresAt, 'expiresAt')
    : null;

  const createArguments: CreateCredentialArguments = {
    issuer,
    holder,
    admin,
    claims: claimsToWire(claims),
    createdAt,
    expiresAt,
    meta: input.meta ?? {},
  };

  const createCommand = {
    CreateCommand: {
      templateId: config.packageName,
      createArguments,
    },
  };

  return buildSubmissionEnvelope(config, commandId, [issuer, holder], [createCommand], false);
}

/**
 * Build the submission body for a `verifyCredential` call.
 *
 * Exercises the `Credential_PublicFetch` choice (inherited from
 * the `Cip204.Standard.Credential` interface) on the template.
 *
 *   * `actAs` is the verifier's party (the choice controller).
 *   * `disclosedContracts` is attached when the verifier's
 *     participant does not have the contract in its local ACS.
 *   * LEDGER_EFFECTS is requested so we get the
 *     `ExercisedEvent.exerciseResult` (the `CredentialView`)
 *     back.
 */
export function buildVerifyCredentialCommand(
  config: CantonConfig,
  input: VerifyCredentialInput,
  commandId: CommandId,
  /**
   * Resolved `<lf-package-hash>:Module:Template` form of
   * `config.packageName`. Required only when attaching a
   * `DisclosedContract` — the v2 JSON Ledger API rejects the
   * `#name:Module:Template` form for that field.
   */
  disclosedTemplateId?: string,
): SubmitAndWaitRequestBody {
  const contractId = validateContractId(input.contractId, 'verifyCredential');
  const actor = validateParty(input.actor, 'actor');
  const expectedAdmin = validateParty(input.expectedAdmin, 'expectedAdmin');

  const exerciseCommand = {
    ExerciseCommand: {
      templateId: config.packageName,
      contractId,
      choice: 'Credential_PublicFetch',
      choiceArgument: { expectedAdmin, actor },
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
    [actor],
    [exerciseCommand],
    true,
    disclosedContracts,
  );
}

/**
 * Convert a base64url-encoded blob (URL-safe alphabet with no
 * padding) to standard base64. Canton's JSON Ledger v2 API strictly
 * validates `createdEventBlob` as standard base64.
 */
function normalizeToStandardBase64(s: string): string {
  const swapped = s.replace(/-/g, '+').replace(/_/g, '/');
  const padNeeded = (4 - (swapped.length % 4)) % 4;
  return padNeeded === 0 ? swapped : swapped + '='.repeat(padNeeded);
}

/**
 * Build the submission body for a `revokeCredential` call.
 *
 * The `RevokeCredential` choice is implementer-specific (NOT part
 * of CIP #204). It cascade-burns the bound NFT atomically when
 * `nftContractId` is supplied. The reason string is stamped onto
 * the new revoked sibling's meta inside the choice body.
 *
 * `actAs` is the issuer party (the choice controller).
 */
export function buildRevokeCredentialCommand(
  config: CantonConfig,
  input: RevokeCredentialInput,
  issuerParty: PartyId,
  commandId: CommandId,
): SubmitAndWaitRequestBody {
  const contractId = validateContractId(input.contractId, 'revokeCredential');
  const issuer = validateParty(issuerParty, 'issuerParty');
  const nftCid =
    input.nftContractId !== undefined && input.nftContractId.length > 0
      ? validateContractId(input.nftContractId, 'revokeCredential.nftCid')
      : null;
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    throw new CantonError(
      'invalid_command',
      'revokeCredential: reason must be a non-empty string.',
    );
  }

  const exerciseCommand = {
    ExerciseCommand: {
      templateId: config.packageName,
      contractId,
      choice: 'RevokeCredential',
      choiceArgument: { nftCid, reason: input.reason },
    },
  };

  return buildSubmissionEnvelope(config, commandId, [issuer], [exerciseCommand], false);
}

/* ---------- KycNFT (optional companion) ---------- */

export interface CreateKycNftArguments {
  readonly issuer: PartyId;
  readonly customer: PartyId;
  readonly boundCredentialId: ContractId;
  readonly issuedAt: string;
  readonly level: string;
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
}

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
 * The NFT template's `level` value is application-defined; the SDK
 * forwards the string verbatim. The DAML ensure clause enforces
 * non-empty fields at the chain boundary.
 */
export function buildCreateKycNftCommand(
  config: CantonConfig,
  input: CreateKycNftInput,
  issuerParty: PartyId,
  commandId: CommandId,
  clock: () => Date = () => new Date(),
): SubmitAndWaitRequestBody {
  const issuer = validateParty(issuerParty, 'issuerParty');
  const customer = validateParty(input.holderParty, 'holderParty');
  const boundCredentialId = validateContractId(input.boundCredentialId, 'createKycNft');
  const level = validateBoundedNonEmpty(input.level, 64, 'level');
  const serialNumber = validateBoundedNonEmpty(input.serialNumber, 64, 'serialNumber');
  const displayName = validateBoundedNonEmpty(input.displayName, 256, 'displayName');
  const image = validateBoundedNonEmpty(input.image, 350_000, 'image');
  const issuedAt = clock().toISOString();

  const createArguments: CreateKycNftArguments = {
    issuer,
    customer,
    boundCredentialId,
    issuedAt,
    level,
    serialNumber,
    displayName,
    image,
  };

  const createCommand = {
    CreateCommand: {
      templateId: `${config.packageName.replace(/:Credential$/, '')}:KycNFT`,
      createArguments,
    },
  };

  return buildSubmissionEnvelope(config, commandId, [issuer], [createCommand], false);
}
