/**
 * Proof-hash + schema infrastructure.
 *
 * Audit-replay design:
 *
 *   * The on-chain `Canton.VC.Credential.proofHash` field carries a
 *     SHA-256 hex digest of a `ProofSchemaSpec`-driven canonical JSON
 *     form of the issuer's named identity payload. The hash INPUT
 *     contains PII (name, DOB, document number, etc.) so the digest
 *     binds the credential to a real person; the INPUT bytes never
 *     leave the issuer's secure storage. The OUTPUT (hex digest) is
 *     public and one-way — no PII recoverable from the chain alone.
 *
 *   * The on-chain `Canton.VC.Credential.proofSchemaId` field carries
 *     a content-addressed hash of the `ProofSchemaSpec` itself
 *     (`sha256(canonical(spec))`). Auditors fetch the schema by id
 *     from a public registry (`docs/proof-schemas/<id>.json` in this
 *     repo or any mirror), then replay the proofHash using the
 *     schema's `fieldsInOrder` ordering against the firm's retained
 *     raw bytes.
 *
 *   * Salt: every adapter's schema includes a vendor-side opaque ID
 *     (sessionId / applicantId / inquiryId) in its `fieldsInOrder`,
 *     which makes the hash input unpredictable to a non-issuer
 *     attacker — defeats brute-force / rainbow-table attacks against
 *     low-entropy fields like name + DOB alone.
 *
 *   * Canonicalization is deterministic and language-agnostic. The
 *     three rules:
 *       1. `sortKeys` — every object's keys sorted lexicographically
 *          (ASCII) before serialization.
 *       2. `shortenFloats` — whole-number floats (`100.0`) coerced to
 *          integers (`100`) before serialization so the bytes match
 *          a Python `int()` re-encoding.
 *       3. `JSON.stringify` default tight form (no whitespace, `,:`
 *          separators).
 *
 *     This matches Python's `json.dumps(obj, separators=(',', ':'),
 *     sort_keys=True)` after `int()` coercion, so an auditor can
 *     replay in any runtime.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { CantonError } from './errors';

/* ---------- Canonical JSON (sortKeys + shortenFloats) ---------- */

/**
 * Recursively normalize whole-number floats to integers
 * (`42.0` → `42`). Non-integer floats pass through unchanged.
 * Matches Python `int(value)` coercion semantics so a canonical
 * JSON produced in TypeScript matches a canonical JSON produced in
 * Python for the same logical value.
 */
export function shortenFloats(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shortenFloats);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = shortenFloats(inner);
    }
    return result;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    if (!Number.isInteger(value) && value % 1 === 0) return Math.trunc(value);
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  // bigint / symbol / function / undefined collapse to null so the
  // canonical bytes do not carry runtime-specific garbage.
  return null;
}

/**
 * Recursively rebuild a JSON-like value with object keys sorted in
 * lexicographic (ASCII) order. Arrays preserve original order. Scalar
 * values pass through unchanged.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Serialize a JSON-like value to its canonical UTF-8 byte string.
 * Deterministic across runtimes when the input contains only JSON
 * primitives + finite numbers. Pipeline:
 *
 *   canonicalJson(v) === JSON.stringify(sortKeys(shortenFloats(v)))
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(value)));
}

/* ---------- ProofSchemaSpec ---------- */

/**
 * Canonical form identifier. Single value supported today
 * (`'jcs-sortKeys+shortenFloats/sha256/v1'`). New canonical
 * pipelines (e.g. true RFC 8785 JCS, or BLAKE3 hashing) get new
 * identifiers and live as siblings; existing credentials remain
 * verifiable against their original spec forever.
 */
export const CANONICAL_FORM_DEFAULT = 'jcs-sortKeys+shortenFloats/sha256/v1' as const;
export type CanonicalForm = typeof CANONICAL_FORM_DEFAULT;

/**
 * The bytes-on-the-wire identity of a proof schema. Two specs with
 * identical contents produce identical `id` values — schemas are
 * content-addressed.
 *
 * Stored alongside every Canton.VC.Credential on chain (as
 * `proofSchemaId`). An auditor fetches `docs/proof-schemas/<id>.json`,
 * confirms the schema matches the on-chain id, then replays the
 * proofHash with the firm's retained raw bytes against
 * `fieldsInOrder`.
 *
 * Spec content includes:
 *
 *   * `vendor` — opaque vendor name (`"didit"`, `"sumsub"`,
 *     `"persona"`, …). Bound to the credential's `validator` field.
 *   * `schemaVersion` — adapter-side semver string. Bump when the
 *     adapter must change the field set; old credentials replay
 *     against the old schema id.
 *   * `fieldsInOrder` — the named identity fields in the exact order
 *     they appear in the hash input object. Order matters because
 *     canonicalization sorts keys; specifying order makes the spec
 *     auditable without inspecting code.
 *   * `canonicalForm` — pinned to the canonical pipeline identifier
 *     above so future pipelines do not collide on existing ids.
 */
export interface ProofSchemaSpec {
  readonly vendor: string;
  readonly schemaVersion: string;
  readonly fieldsInOrder: readonly string[];
  readonly canonicalForm: CanonicalForm;
}

/**
 * Content-addressed id of a {@link ProofSchemaSpec}. Stable across
 * runtimes because the spec itself goes through `canonicalJson` first.
 */
export function computeSchemaId(spec: ProofSchemaSpec): string {
  // Validate the spec before fingerprinting. A typo here is much
  // cheaper to catch at issuance than during a five-year-later audit.
  if (typeof spec.vendor !== 'string' || spec.vendor.length === 0) {
    throw new CantonError('invalid_proof_schema', 'ProofSchemaSpec.vendor must be a non-empty string.');
  }
  if (typeof spec.schemaVersion !== 'string' || spec.schemaVersion.length === 0) {
    throw new CantonError(
      'invalid_proof_schema',
      'ProofSchemaSpec.schemaVersion must be a non-empty string.',
    );
  }
  if (!Array.isArray(spec.fieldsInOrder) || spec.fieldsInOrder.length === 0) {
    throw new CantonError(
      'invalid_proof_schema',
      'ProofSchemaSpec.fieldsInOrder must be a non-empty array.',
    );
  }
  const seen = new Set<string>();
  for (const field of spec.fieldsInOrder) {
    if (typeof field !== 'string' || field.length === 0) {
      throw new CantonError(
        'invalid_proof_schema',
        'ProofSchemaSpec.fieldsInOrder entries must be non-empty strings.',
      );
    }
    if (seen.has(field)) {
      throw new CantonError(
        'invalid_proof_schema',
        `ProofSchemaSpec.fieldsInOrder contains duplicate field "${field}".`,
      );
    }
    seen.add(field);
  }
  if (spec.canonicalForm !== CANONICAL_FORM_DEFAULT) {
    throw new CantonError(
      'invalid_proof_schema',
      `ProofSchemaSpec.canonicalForm must be "${CANONICAL_FORM_DEFAULT}" (got "${spec.canonicalForm}").`,
    );
  }
  const canonical = canonicalJson({
    vendor: spec.vendor,
    schemaVersion: spec.schemaVersion,
    fieldsInOrder: spec.fieldsInOrder,
    canonicalForm: spec.canonicalForm,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ---------- Proof hash ---------- */

/**
 * Allowed leaf-value types for proof hash inputs. Restrict to
 * primitives to keep the canonical bytes simple and auditor-friendly
 * — nested objects/arrays in identity payloads obscure the audit
 * trail and would require schema sub-paths to express.
 */
export type ProofHashLeafValue = string | number | boolean | null;
export type ProofHashValues = Readonly<Record<string, ProofHashLeafValue>>;

export interface ProofHashResult {
  /** Hex-encoded SHA-256 of the canonical proof input. */
  readonly proofHash: string;
  /** Content-addressed id of the schema this hash binds to. */
  readonly proofSchemaId: string;
  /**
   * The canonical UTF-8 bytes the SHA-256 was computed over. Adapters
   * usually drop this on the floor; auditors and debug paths use it
   * to inspect the exact wire input behind the hash.
   */
  readonly canonical: string;
}

/**
 * Compute `{ proofHash, proofSchemaId, canonical }` from a schema
 * spec + a key→value map for every field the schema names.
 *
 * Strict contract: the input map MUST cover exactly the field set
 * declared by `spec.fieldsInOrder`. Extra fields are rejected
 * (typo guard). Missing fields are rejected (audit-replay safety —
 * absent vs `""` would silently differ in the canonical bytes).
 *
 * The input object is rebuilt with keys in `fieldsInOrder` so the
 * post-`sortKeys` byte string is identical across runtimes. The
 * canonical pipeline then handles deterministic serialization.
 */
export function computeProofHash(
  spec: ProofSchemaSpec,
  values: ProofHashValues,
): ProofHashResult {
  const proofSchemaId = computeSchemaId(spec);

  const inputKeys = Object.keys(values);
  const specFields = new Set(spec.fieldsInOrder);
  for (const key of inputKeys) {
    if (!specFields.has(key)) {
      throw new CantonError(
        'invalid_proof_input',
        `computeProofHash: value "${key}" is not declared in the schema's fieldsInOrder.`,
        { context: { vendor: spec.vendor, schemaVersion: spec.schemaVersion } },
      );
    }
  }
  const missing: string[] = [];
  for (const field of spec.fieldsInOrder) {
    if (!(field in values)) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new CantonError(
      'invalid_proof_input',
      `computeProofHash: schema requires fields not present in values: [${missing.join(', ')}].`,
      { context: { vendor: spec.vendor, schemaVersion: spec.schemaVersion, missing } },
    );
  }

  // Rebuild the input with explicit key ordering. `sortKeys` will
  // resort lexicographically anyway, but starting from a known
  // ordering keeps the pre-canonical form deterministic for
  // debugging.
  const ordered: Record<string, ProofHashLeafValue> = {};
  for (const field of spec.fieldsInOrder) {
    ordered[field] = values[field] as ProofHashLeafValue;
  }
  const canonical = canonicalJson(ordered);
  const proofHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return Object.freeze({ proofHash, proofSchemaId, canonical });
}
