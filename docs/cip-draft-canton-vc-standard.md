# CIP-XXXX: Canton Verifiable Credentials Standard

**Status:** Draft
**Type:** Standards Track
**Author:** [Abdullah Faruk Özden](https://github.com/Farukest)
**Created:** 2026-05-21
**Reference implementation:** https://github.com/canton-vc/canton-vc

---

## Abstract

This CIP defines a standard for issuing, holding, and verifying
KYC / identity verifiable credentials on the Canton Network. The
standard covers (a) the DAML template signatures every conforming
issuer publishes, (b) the OAuth 2.0 / OIDC wire format the issuer
exposes for verifier integration, and (c) the `DisclosedContract`
carriage mechanism through which a verifier authenticates a
credential against its own Canton participant without trusting the
issuer.

The standard is designed to be Canton-native: it uses the existing
stakeholder privacy model and `DisclosedContract` authentication
instead of an off-chain credential + on-chain ZK verifier overlay.
It does not preclude ZK-based alternatives; it specifies the
canonical pattern for issuers who want their credentials to be
verified on chain with full payload disclosure for institutional
audit use cases.

---

## Motivation

Canton has no canonical pattern for verifiable credentials today.
Each issuer that wants to mint a KYC credential on Canton makes
independent choices about template shape, payload semantics, wire
format, and verifier integration. The result:

- **No interoperability.** A firm that integrates issuer A's
  credentials needs to write a separate adapter for issuer B's
  credentials, even though both are doing the same conceptual work.
- **No reference implementation.** Open-source teams that want to
  ship a KYC adapter for their dApp must rebuild the wire layer
  from JSON Ledger v2 primitives, audit it themselves, and own the
  ongoing maintenance.
- **No verifier guarantee.** A firm receiving an OIDC userinfo
  response with KYC claims has no standard way to verify the claims
  cryptographically — they either trust the issuer's signed
  response (trust ≠ trustless) or read the issuer's bespoke docs to
  figure out how to query the chain.

This CIP fixes all three by standardizing the template signatures,
wire format, and verification flow.

---

## Specification

### 1. DAML template signatures

A conforming issuer publishes the following DAML templates under
the `Canton.VC` module namespace:

```daml
module Canton.VC.Credential where

import DA.Time

template Credential
  with
    operator     : Party
    user         : Party
    userRef      : Text       -- opaque, no PII
    proofHash    : Text       -- SHA-256 hex (lowercase) of audit artifact
    status       : Text       -- "Active" | "Suspended" | "Revoked"
    level        : Text       -- "Basic" | "Enhanced"
    validUntil   : Time       -- credential expiry
    network      : Text       -- "Canton Mainnet" | "Canton Devnet" | …
    humanScore   : Decimal    -- 0..100, vendor-attested
    validator    : Text       -- KYC vendor brand (e.g. "Didit")
    identityVerified  : Bool
    livenessVerified  : Bool
    addressVerified   : Bool
  where
    signatory operator
    observer user

    nonconsuming choice Verify : CredentialView
      with
        fetcher : Party
      controller fetcher
      do
        now <- getTime
        let isActive = status == "Active" && now <= validUntil
        return CredentialView with
          userRef
          proofHash
          status
          level
          validUntil
          network
          humanScore
          validator
          identityVerified
          livenessVerified
          addressVerified
          isActive

    choice Revoke : ()
      with
        revokedBy : Party
        reason    : Text
      controller operator
      do
        -- cascade-archive any KycNFT bound to this credential
        ...

data CredentialView = CredentialView with
  userRef           : Text
  proofHash         : Text
  status            : Text
  level             : Text
  validUntil        : Time
  network           : Text
  humanScore        : Decimal
  validator         : Text
  identityVerified  : Bool
  livenessVerified  : Bool
  addressVerified   : Bool
  isActive          : Bool
  deriving (Eq, Show)
```

Issuers MAY add additional optional fields under their own namespace
(e.g. `Canton.VC.Credential.MyExtension`) but MUST NOT alter the
above signatures. The `Verify` choice signature is the
interoperability point; verifier-side code depends on it.

The companion `Canton.VC.KycNFT` template (optional) is a soulbound
NFT bound to a `Credential` via `boundCredentialId`. The `Revoke`
choice on the `Credential` cascade-archives any bound NFTs in the
same transaction.

### 2. OAuth 2.0 / OIDC scope strings

The issuer's authorize endpoint MUST accept the following scope
strings (and MAY accept others):

| Scope | Effect |
|---|---|
| `openid` | Issue an `id_token` with `sub`. |
| `kyc` | Emit identity / liveness / address verification flags. |
| `kyc:address` | Emit address-line attributes (street / city / postal). |
| `kyc:scores` | Emit humanity / risk scores. |
| `canton-vc` | Emit the on-chain disclosure bundle. |

The `canton-vc` scope is the primary one for this standard:
when granted, the userinfo response MUST include the
`canton_vc_credential_blob` and `canton_vc_contract_id` claims (see §3).

### 3. Userinfo claim names

When the `canton-vc` scope is granted and the user holds an active
credential, the issuer's userinfo response MUST include:

- `canton_vc_credential_blob` (string, base64url): the Canton
  `createdEventBlob` for the user's active `Canton.VC.Credential`
  contract. Self-authenticating against the sequencer signature.
- `canton_vc_contract_id` (string): the contract id the blob
  corresponds to.

The response SHOULD include:

- `canton_vc_proof_hash` (string): SHA-256 hex of the canonical JSON
  form of a named-field identity payload (see §7 below).
- `canton_vc_proof_schema_id` (string): content-addressed id of the
  `ProofSchemaSpec` used to compute `canton_vc_proof_hash`. Verifiers
  resolve this id against a public schema registry (typically
  `https://github.com/<issuer>/canton-vc/blob/main/docs/proof-schemas/<id>.json`)
  to learn which fields the hash was computed over and in what order.
- `canton_vc_level` (`"basic"` | `"enhanced"`)
- `canton_vc_valid_until` (ISO 8601 string)
- `canton_vc_network` (string)

Verifiers MUST accept only the canonical `canton_vc_*` names.
Issuers MUST emit the canonical names; any vendor-specific aliases
MUST be renamed at the issuer's wire layer before they reach the
userinfo response.

### 4. Verifier flow

A verifier receiving the userinfo response performs:

1. Validate the OIDC response (signature, audience, nonce).
2. Extract `canton_vc_credential_blob` + `canton_vc_contract_id`.
3. Submit a `Verify` choice exercise on the issuer's
   `Canton.VC.Credential` template, with:
   - `DisclosedContract.contractId` = the contract id from the claim
   - `DisclosedContract.templateId` = canonical
     `<lf-hash>:Canton.VC.Credential:Credential` form (the
     verifier's participant resolves the hash from any active
     contract under that template name; see §5 for upgrade semantics)
   - `DisclosedContract.createdEventBlob` = the blob from the claim
     (normalized from base64url to standard base64)
4. The verifier's participant authenticates the blob against the
   sequencer signature, runs the `Verify` choice body, and returns
   the `CredentialView` struct.
5. Verifier MUST check `view.isActive === true` and `view.userRef`
   matches the `sub` claim before honoring the credential.

### 5. Package upgrade semantics

The `Canton.VC.Credential` template MAY be deployed under
different package versions over time. Credentials minted under
one version retain their package hash in the `createdEventBlob`
forever. A `DisclosedContract.templateId` MUST match the embedded
template id in the blob; verifiers SHOULD resolve the hash
per-contract (query the ACS for the specific `contractId` and
read its `templateId` field), not globally per package name.

### 6. Error taxonomy

Verifier-side errors that conforming SDK implementations surface:

- `disclosure_blob_missing` — userinfo response had no
  `canton_vc_credential_blob`.
- `disclosure_contract_id_missing` — userinfo response had no
  `canton_vc_contract_id`.
- `disclosed_contract_authentication_failed` — Canton participant
  rejected the blob (tampered, fabricated, or not for this
  contract id).
- `credential_not_active` — `Verify` returned but `view.isActive`
  was `false` (revoked or expired).
- `user_ref_mismatch` — `view.userRef` did not match `sub`.

DAML-side errors raised inside `Verify` (other than the participant
authentication failure) propagate as `submit_failed` with the DAML
exception message preserved.

### 7. Proof hash + schema registry (audit-replay)

The on-chain `proofHash` field MUST be a SHA-256 hex digest computed
over a deterministic canonical JSON of a named-field identity
payload. The set of fields and their order are pinned by a
`ProofSchemaSpec` document with the shape:

```
{
  "vendor": "<adapter-vendor-tag>",
  "schemaVersion": "v1",
  "fieldsInOrder": ["vendor", "schemaVersion", "<vendor-side-id>", ...],
  "canonicalForm": "jcs-sortKeys+shortenFloats/sha256/v1"
}
```

The spec's own SHA-256 is the `proofSchemaId`, written to the
credential at mint time. Schemas are content-addressed: any field
change produces a new id, so credentials remain auditable against
their original schema forever even if the issuer later evolves the
adapter.

The canonical pipeline (`canonicalForm: "jcs-sortKeys+shortenFloats/sha256/v1"`)
applies, in order:

1. `shortenFloats` — whole-number floats coerced to integers
   (`42.0` → `42`) to match Python `int()` semantics.
2. `sortKeys` — object keys sorted lexicographically (ASCII),
   recursively.
3. `JSON.stringify` with default tight separators (no whitespace).
4. SHA-256 over the UTF-8 bytes; hex output.

A conforming issuer publishes the spec at a public URL
(repository, mirror, or both) under the file name `<id>.json`.
A regulator or auditor:

1. Reads `proofSchemaId` from the on-chain `CredentialView`.
2. Fetches `<id>.json` from the public registry.
3. Loads the firm's retained raw bytes for the named fields.
4. Applies the canonical pipeline + SHA-256.
5. Compares against the on-chain `proofHash`.

A match proves the credential was bound to the exact identity bytes
the firm retained, at the time of mint, without exposing any PII on
chain (the digest is one-way; vendor-side opaque ids in the input
act as salts that defeat brute-force).

---

## Rationale

### Why DAML-native instead of ZK

Canton's stakeholder model already provides selective disclosure
by default: a contract is only visible to listed parties.
`DisclosedContract` extends this with a self-authenticating blob
mechanism that lets a non-stakeholder verifier run a choice on a
contract via their own participant. The combination is functionally
equivalent to ZK selective-disclosure for the issuer-verifier-user
triple — without the cost of a circuit toolchain, the audit overhead
of a custom verifier contract, or the runtime of an on-chain ZK
proof check.

For institutional compliance use cases (regulator inspection,
SAR filing, audit trail), the full `CredentialView` payload IS
the audit artifact. A ZK selective-disclosure proof leaves a "we
verified something but can't show what" gap that does not survive
regulator review in those contexts.

### Why a vendor-agnostic adapter pattern

Different KYC vendors (Didit, Onfido, Persona, Sumsub, Veriff,
Au10tix, Jumio, …) expose meaningfully different APIs, response
shapes, status enums, and webhook signature schemes. The standard
prescribes the `KycProvider` interface (in the reference
implementation) so issuers can swap vendors without touching the
Canton wire layer. The standard does not prescribe which vendor an
issuer must use.

### Why `userRef` instead of identity

The `userRef` field MUST NOT contain PII. The reference
implementation uses an opaque UUID. The credential's
cryptographic binding is to the proof hash; the verifier learns
nothing about the user beyond what the issuer chose to put in
`CredentialView` (which is intentionally narrow — verification
flags + level + scores, not name / address / DOB).

---

## Backward compatibility

Operators with pre-existing credentials under a vendor-specific
DAML namespace can deploy the canonical `Canton.VC.Credential`
package alongside their legacy package on the same participant.
Both DARs coexist; existing on-chain credentials continue to verify
under the legacy `Verify` choice, and new mints use the canonical
canton-vc package.

On the OIDC wire side, SDK verifiers in this reference
implementation accept only canonical `canton_vc_*` claim names.
Operators with a vendor-specific claim prefix MUST rename their
claims to the canonical names at the issuer's wire layer before
emitting them.

---

## Reference implementation

The reference implementation is at
https://github.com/Farukest/canton-vc, Apache 2.0 licensed.

---

## Open issues

- **NFT cascade semantics.** The reference implementation's
  `Revoke` choice cascade-archives bound `KycNFT` contracts in the
  same transaction. Should the standard mandate this, leave it
  optional, or split NFT semantics into a separate CIP?
- **Multi-issuer ecosystem.** When multiple issuers operate on
  Canton concurrently, what does the `validator` field convention
  look like for verifiers that want to gate on issuer identity
  (e.g. "only accept credentials issued by operator X")?
- **Re-mint vs upgrade.** For operators with existing on-chain
  credentials under a vendor-specific namespace, smart-contract
  upgrade is the preferred migration path. Is there a
  contract-template authority outside the issuer that the upgrade
  should be signed by?
