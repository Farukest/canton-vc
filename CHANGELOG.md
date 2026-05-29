# Changelog

All notable changes to `canton-vc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] — 2026-05-29

### Added — CIP #204 optional factory interface

- **DAR v2.2.0** mainnet-deployed alongside v2.1.0 (package id `16fb51c2e9703cef173c76babd755afca9c7a01e34fc947aebc12205fdf0f719`, vetted with `UPDATE_VETTED_PACKAGES_FORCE_FLAG_ALLOW_VET_INCOMPATIBLE_UPGRADES`). Adds the `Cip204.Factory.CredentialFactory` interface and a `Canton.VC.Credential:CredentialFactory` template implementing it. Bulk update is exercised via `CredentialFactory_UpdateCredentials` on a joint-signatory (issuer + holder) factory contract per the spec's optional factory pattern. The legacy template-level `UpdateCredentials` choice on `Credential` is retained on v2.2.0 for Smart Contract Upgrade backward-compat with v2.1.0 mainnet contracts; it is marked deprecated for new v2.2.0+ callers.
- **SDK v0.3.0** across 7 packages. `buildUpdateCredentialsCommand` reroutes to the factory pathway with a two-step orchestration: a `CreateCommand` mints an ephemeral `CredentialFactory` under joint signatory (issuer + holder), then a follow-up `ExerciseCommand` against the factory's interface id (`Cip204.Factory:CredentialFactory`) runs `CredentialFactory_UpdateCredentials` and archives the factory in the same transaction. The split is mandated by the JSON Ledger API spec — `CreateAndExerciseCommand` only addresses template-level choices, so an interface choice on a template's implementation must be exercised as a separate command. `UpdateCredentialsInput` gained `holderParty` (required) and `adminParty` (optional, defaults to issuer). The public client surface (`canton.updateCredentials({...})`) is signature-compatible aside from those two new fields; existing callers add `holderParty` and the rest is internal.

### Changed

- `updateCredentials()` is now CIP #204 spec-aligned — joint signatory `issuer + holder` is required, matching the factory choice's controller set. Implementer pipelines that handle level transitions via revoke + remint do not call `updateCredentials()` and need no app-layer migration; the operational footprint of the change is the smoke-trail scripts and any future implementer adopting the bulk-refresh pathway.

### Mainnet vetting trail

| Package id | Status |
|---|---|
| `562bbc757d5e…` (v2.1.0) | Active — existing credentials remain queryable + exerciseable, legacy `UpdateCredentials` choice still callable |
| `16fb51c2e970…` (v2.2.0) | Active — new factory pathway, all v2.1.0 surface still present |

The v2.1.0 package will be unvetted in a future release once all existing credentials minted on it have been superseded or expired (Canton upgrade-doc §4.1.2: "all v1 contracts must be fully upgraded before unvetting v1").

---

## [0.2.0] — 2026-05-28

### BREAKING — Pure CIP #204 alignment

The on-chain DAML template was rewritten end-to-end to adopt the [Canton Verifiable Credentials Standard (CIP #204)](https://github.com/canton-foundation/cips/pull/204). The SDK, DAR, and adapters all migrated to the standard surface as a single step — no compatibility shim, no layered fallback.

#### Added

- **DAR v2.1.0** mainnet-deployed (package id `562bbc757d5ec55fba320bf7370588b356811b3f2556817f49098de467758ea4`). Implements the `Cip204.Standard.Credential` interface verbatim plus three implementer extensions: `RevokeCredential` (issuer compliance with cascade NFT burn), `UpdateCredentials` (issuer-side bulk claims refresh — archive + sibling create with new `claims` map + `canton-vc/update.reason` meta stamp), and the optional `KycNFT` companion + standalone `BurnNft`.
- **SDK v0.2.0** across 7 packages: `archiveAsHolder()` (CIP #204 `Credential_ArchiveAsHolder`), `updateCredentials()` (implementer bulk refresh), `burnNft()` (standalone NFT burn), `createClaimSchema(namespace, keys)` factory for typed reverse-DNS claim-key registries.
- Interface-id derivation helper in `@canton-vc/core` so `ExerciseCommand.templateId` correctly addresses interface choices vs template choices.
- ACS query layer is now fault-tolerant — contracts created under a prior DAR version with a divergent storage shape are silently skipped instead of surfacing as a transport error.

#### Changed

- `createCredential()` uses joint signatories per CIP #204 — `actAs` carries both `issuerParty` and `holderParty`; both must be hosted on the submitting participant. New `adminParty` field declares the disclosure authority that `Credential_PublicFetch` callers will pass as `expectedAdmin`.
- `verifyCredential()` exercises `Credential_PublicFetch` (CIP #204 interface, nonconsuming). Signature now takes `{ actor, expectedAdmin }`; the implementer asserts `expectedAdmin == admin` inside the choice body — substituted credentials are rejected at the chain boundary, not silently.
- Wire shape switched to the CIP #204 structural payload: `(issuer, holder, admin, claims : TextMap Text, createdAt, expiresAt, meta)`. Flat root fields (`proofHash`, `level`, `validator`, `humanScore`, …) collapsed into the `claims.values` TextMap under the consumer's chosen reverse-DNS namespace per CIP #204 §"Namespacing".
- Mainnet swap: the prior `Crivacy.KYCCredential v0.0.x` DAR is permanently unvetted on mainnet — no new mints land on it. Existing on-chain contracts remain queryable for audit lookup against their original package id.
- `verifyDisclosure()` in `@canton-vc/credential` migrated to the `actor` + `expectedAdmin` form. Documentation example rewritten.

#### Removed

- **`Verify` choice** — replaced by the CIP #204 standard `Credential_PublicFetch` interface choice.
- **`MigrateValidator` choice** — replaced by `UpdateCredentials` (same semantic: archive current + create sibling with new claims, but parametrised over the full claims map rather than a single field).
- **`Canton.VC.Credential.ValidatorType` enum** — validator label is now a free-form text claim under the issuer's reverse-DNS namespace (e.g. `com.example/validator = 'DiditValidator'`). Adding a new vendor is a label change, not a DAR upgrade.
- Application-layer enums (`KycLevel`, `CredentialStatus`, `Validator`, `CanonicalNetwork`) and `DAML_TO_DB_*` / `DB_TO_DAML_*` mapping tables — these belong in consumer code, not the SDK. The library stays agnostic of any specific issuer vocabulary.

#### Verified

- End-to-end live mainnet smoke for both Sumsub and Persona sandbox APIs — 16 phases each, every DAML choice exercised (`createCredential` × 4 credentials, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` with NFT cascade, `UpdateCredentials`, `createKycNft`, standalone `BurnNft`, wrong-admin reject path). Sample contract ids recorded in the per-package CHANGELOG entries (`packages/adapter-sumsub/CHANGELOG.md`, `packages/adapter-persona/CHANGELOG.md`).

#### Production reference deployment

- The production reference deployment documented under the grant proposal's §M1 swapped to v2.1.0 in the same window; the firm-facing API surface (REST endpoints, OAuth claim names, webhook event types) stayed contract-stable, with `credential.updated` + `credential.expired` events added to the `WebhookEventType` enum.

---

## [0.1.0] — 2026-05-25

### Added

- Initial open-source release of `canton-vc`. Apache 2.0 across all packages.
- `@canton-vc/core` — Canton JSON Ledger v2 client (wire layer): config + Zod schemas, command builders for `CreateKycCredential` / `Verify` / `RevokeCredential` / `CreateKycNft`, retry-aware fetch, party parsing, per-contract `DisclosedContract.templateId` resolver for credentials that outlive a package upgrade.
- `@canton-vc/credential` — high-level OAuth 2.0 / OIDC client + `verifyDisclosure()` helper.
- `@canton-vc/kyc-provider` — vendor-agnostic `KycProvider` interface decoupling the issuer pipeline from any specific KYC vendor.
- `@canton-vc/adapter-didit` — production adapter wrapping the Didit v3 sessions API + HMAC-SHA256 webhook signature scheme (canonical JSON, `X-Signature-V2`, 5-minute drift window).
- `@canton-vc/adapter-sumsub` — production adapter wrapping the Sumsub applicants API. Implements Sumsub's per-request HMAC authentication scheme (signature over `ts + method + path + body`, sent in `X-App-Access-Sig`) plus the multi-algorithm webhook digest scheme (`X-Payload-Digest` with the algorithm selected by `X-Payload-Digest-Alg`, supporting SHA1 / SHA256 / SHA512). End-to-end verified against the real Sumsub API and a Canton 3.4 participant.
- `@canton-vc/adapter-persona` — third production adapter (Persona inquiry API, JSON:API envelope, `Persona-Signature` HMAC-SHA256 webhook scheme with multi-secret key rotation, hosted one-time-link inquiry flow). End-to-end verified against the real Persona API and a Canton 3.4 participant — full chain including the `KycNFT` cascade-revoke path. Validates the `KycProvider` interface against a third structurally distinct vendor.
- `@canton-vc/adapter-mock` — deterministic adapter for tests and local development, no network calls.

  The three adapters (Didit, Sumsub, Persona) differ across auth scheme, identity model, workflow vocabulary, and webhook signature format, so shipping all three validates the `KycProvider` interface as vendor-agnostic in practice.

- `daml/canton-vc-credential` — DAML 3.4.11 package with the `Canton.VC.Credential` module + pre-built DAR shipped under `release/` for direct upload to any Canton 3.4 participant.
- `@canton-vc/core` proof-hash module — content-addressed `ProofSchemaSpec` + canonical JSON pipeline (`sortKeys + shortenFloats + JSON.stringify + SHA-256`) + `computeProofHash(spec, values)` + `computeSchemaId(spec)`. Adapters declare a named-field schema; on-chain `proofHash` and `proofSchemaId` are derived together. Replaces the prior "hash whatever the vendor returns" placeholder; raw vendor blobs no longer leak schema drift into the digest.
- Content-addressed proof-schema infrastructure: `proofSchemaId` is computed at mint time, written alongside the credential, and resolves at `docs/proof-schemas/<id>.json` for downstream audit replay.
- `docs/proof-schemas/<id>.json` — public proof-schema registry for the three production adapters. Auditors look up the on-chain `proofSchemaId` here to learn which named fields were hashed and in what order, then replay the digest against the firm's retained raw bytes.
- `docs/security-considerations.md` — threat model + adapter-authoring rules (companion to [CIP #204](https://github.com/canton-foundation/cips/pull/204)).
- `examples/issuer-demo` — runnable Node CLI exercising the issuer pipeline (`startSession` → `fetchDecision` → `createCredential`) against the mock vendor by default, or any of Didit / Sumsub / Persona sandbox APIs via `.env`. No Canton participant required; ships with an in-memory canton mock for the on-chain leg.
- `examples/verifier-demo` — runnable Vite + React SPA exercising the verifier surface end-to-end. Three panels (issue, verify, NFT cascade-revoke) drive the real `verifyDisclosure()` helper against an in-memory canton mock. Default mode is mock-only (`pnpm dev` opens the SPA in 30 seconds, no credentials). Optional **real vendor sandbox mode**: pick Didit / Sumsub / Persona from the header dropdown and paste sandbox keys into `.env`; the SPA then drives the real `@canton-vc/adapter-*` adapters through a co-located `vendor-server.ts` Node proxy (HMAC signing, Persona-Version pinning, and Sumsub digest stay server-side — keys never reach the browser bundle).
- `proposals/canton-vc-sdk.md` — grant proposal for the Canton Foundation development fund (1,500,000 CC over 4 months).
