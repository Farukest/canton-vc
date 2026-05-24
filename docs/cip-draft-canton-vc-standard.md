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

-- The KYC vendor (or attestor type) that produced the off-chain
-- proof anchored by `proofHash`. `Generic` exists so issuers
-- running a vendor without a canonical enum entry can still mint
-- without forcing the schema. New entries are non-breaking under
-- DAML LF 2.x upgrade rules (data constructors appended at end).
data ValidatorType
  = DiditValidator
  | OnfidoValidator
  | PersonaValidator
  | SumsubValidator
  | VeriffValidator
  | Au10tixValidator
  | JumioValidator
  | ZkValidator
  | Generic
  deriving (Eq, Show)

template Credential
  with
    operator         : Party
    user             : Party
    userRef          : Text                -- opaque, no PII
    proofHash        : Text                -- SHA-256 hex of audit artifact
    status           : Text                -- "Active" | "Revoked" | "Expired"
    level            : Text                -- "Basic" | "Enhanced"
    validUntil       : Time
    network          : Text                -- "Canton Mainnet" | "Canton Devnet" | …
    humanScore       : Int                 -- 0..100, vendor-attested
    validator        : ValidatorType       -- canonical enum, see above
    identityVerified : Bool
    livenessVerified : Bool
    addressVerified  : Bool
    -- v1.1.0 addition. Appended at the END of the template fields
    -- (DAML smart-contract upgrade rule: new fields MUST come last).
    -- Optional so v1.0.0 contracts remain upgrade-compatible; the
    -- ensure clause below requires Some <non-empty> on every NEW
    -- mint under v1.1.0+. Legacy v1.0.0 contracts (where
    -- proofSchemaId is None) keep their existing Verify semantics
    -- but verifiers SHOULD treat them as audit-incomplete.
    proofSchemaId    : Optional Text
  where
    signatory operator
    observer user

    -- Mint-time invariants enforced on chain. `proofHash` AND
    -- `proofSchemaId` are both required on every NEW mint under
    -- v1.1.0+: the hash alone is not auditable without the schema
    -- it was computed against.
    ensure
      (status == "Active" || status == "Revoked" || status == "Expired")
        && (level == "Basic" || level == "Enhanced")
        && humanScore >= 0
        && humanScore <= 100
        && userRef /= ""
        && proofHash /= ""
        && (case proofSchemaId of
             Some s -> s /= ""
             None -> False)

    -- Flexible-controller verify path. Any participant that has been
    -- given the disclosed contract blob can attach it to a
    -- `disclosed_contracts` field on its command and exercise this
    -- choice with itself as fetcher. Canton's contract authentication
    -- (sequencer signature + contract-id hash) is enforced before the
    -- choice body runs, so a tampered or fabricated blob is rejected
    -- with DISCLOSED_CONTRACT_AUTHENTICATION_FAILED. Nonconsuming so
    -- multiple firms / multiple verifications do not archive the
    -- credential.
    nonconsuming choice Verify : CredentialView
      with fetcher : Party
      controller fetcher
      do
        now <- getTime
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
          isActive = status == "Active" && now <= validUntil
          proofSchemaId

    -- Operator-only revoke. Consuming. Creates a sibling contract
    -- with status="Revoked" so the chain's update log carries the
    -- revocation event. The optional `nftCid` cascades through
    -- `KycNFT.BurnNft` in the same transaction when the credential
    -- has a bound soulbound NFT. The chain-side integrity check
    -- ensures the supplied NFT cid is actually bound to this
    -- credential — a buggy DB write directing the cascade at an
    -- unrelated NFT is rejected at confirmation time.
    choice RevokeCredential : ContractId Credential
      with nftCid : Optional (ContractId KycNFT)
      controller operator
      do
        case nftCid of
          None -> return ()
          Some cid -> do
            nft <- fetch cid
            assertMsg
              "RevokeCredential: nftCid is not bound to this credential"
              (nft.boundCredentialId == self)
            exercise cid BurnNft
        create this with status = "Revoked"

    -- Non-archiving validator update. Lets the issuer migrate a
    -- credential to a different validator type (e.g. adding ZK
    -- proofs, or moving between KYC vendors) without re-running the
    -- off-chain KYC pipeline or forcing the holder to re-onboard.
    choice MigrateValidator : ContractId Credential
      with newValidator : ValidatorType
      controller operator
      do
        create this with validator = newValidator

data CredentialView = CredentialView with
    userRef          : Text
    proofHash        : Text
    status           : Text
    level            : Text
    validUntil       : Time
    network          : Text
    humanScore       : Int
    validator        : ValidatorType
    identityVerified : Bool
    livenessVerified : Bool
    addressVerified  : Bool
    isActive         : Bool
    -- v1.1.0 addition. Appended at end to preserve upgrade-compat.
    proofSchemaId    : Optional Text
  deriving (Eq, Show)

template KycNFT
  with
    operator          : Party
    customer          : Party
    boundCredentialId : ContractId Credential
    issuedAt          : Time
    level             : Text
    serialNumber      : Text
    displayName       : Text
    image             : Text
  where
    signatory operator
    observer customer

    -- Soulbound — no Transfer / Reassign / ChangeOwner choice.
    -- `customer` is observer only; no choice has the customer as
    -- controller. `image` is expected to carry an inline data URI
    -- (`data:image/svg+xml;base64,…`) so the NFT is fully on-chain.
    ensure
      level == "Enhanced"
        && serialNumber /= ""
        && displayName /= ""
        && image /= ""

    -- Operator-only burn. Triggered by `RevokeCredential` cascade
    -- (atomic same-tx) or by direct admin-driven archive.
    choice BurnNft : ()
      controller operator
      do return ()
```

Issuers MAY add additional optional fields under their own namespace
(e.g. `Canton.VC.Credential.MyExtension`) but MUST NOT alter the
above signatures. The `Verify` choice signature and the
`CredentialView` record shape are the interoperability points;
verifier-side code depends on both.

`ValidatorType` is the canonical on-chain enum for vendor identity;
adding a new vendor constructor at the end of the enum is a
non-breaking change under DAML LF 2.x upgrade rules. Issuers running
a vendor without a canonical enum entry mint under `Generic` until
the standard adopts the new constructor.

`proofSchemaId` was added in v1.1.0 of the reference DAR. New mints
under v1.1.0+ MUST carry a non-empty `proofSchemaId`; the on-chain
`ensure` clause rejects mints that omit it. Legacy v1.0.0 contracts
(where `proofSchemaId` is `None`) continue to verify under their
original `Verify` semantics, but verifiers SHOULD treat them as
audit-incomplete because the on-chain hash cannot be reproduced
without the schema it was computed against.

The `Canton.VC.KycNFT` template (optional companion) is a soulbound
NFT bound to an Enhanced-level `Credential` via `boundCredentialId`.
The `RevokeCredential` choice on the `Credential` cascade-archives
the bound NFT in the same transaction when its contract id is
supplied as the `nftCid` argument.

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
  `RevokeCredential` choice cascade-archives a bound `KycNFT` in
  the same transaction when its contract id is supplied as the
  `nftCid` argument. Should the standard mandate this cascade,
  leave it optional, or split NFT semantics into a separate CIP?
- **Multi-issuer ecosystem.** When multiple issuers operate on
  Canton concurrently, what does the `validator` field convention
  look like for verifiers that want to gate on issuer identity
  (e.g. "only accept credentials issued by operator X")?
- **Re-mint vs upgrade.** For operators with existing on-chain
  credentials under a vendor-specific namespace, smart-contract
  upgrade is the preferred migration path. Is there a
  contract-template authority outside the issuer that the upgrade
  should be signed by?
