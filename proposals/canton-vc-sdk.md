# Canton Verifiable Credentials: Open-Source SDK + CIP #204 Reference Implementation

**Status:** Draft
**Author:** [Abdullah Faruk Özden](https://github.com/Farukest)
**Label:** regulatory-compliance
**[Champion](https://github.com/canton-foundation/canton-dev-fund/blob/main/sig-directory.md):** Canton Foundation
**Repository:** https://github.com/Farukest/canton-vc (Apache 2.0)
**License:** Apache 2.0 across all packages

## Abstract

`canton-vc` is the first production reference implementation of the [Canton Verifiable Credentials Standard (CIP #204)](https://github.com/canton-foundation/cips/pull/204). The repository ships seven TypeScript packages, a DAML template set implementing the `Cip204.Standard.Credential` interface verbatim plus three implementer extensions (`RevokeCredential` with cascade-burn, `UpdateCredentials` for bulk claims refresh, and the optional `KycNFT` companion + `BurnNft`), and three production KYC vendor adapters (Didit, Sumsub, Persona) covering the three most common authentication and webhook signature schemes in the market.

Total ask is 1,500,000 CC over a maximum of 4 months across four milestones. Milestone 1 (~27%) is paid on approval for already-delivered work; the remaining ~73% is gated on milestone acceptance, with Milestone 4 priced per achieved adoption sub-KPI.

The codebase open-sourced here has been running in production at [Crivacy.io](https://crivacy.io) for approximately six months on Canton mainnet, where it powers KYC credential issuance and verification across Didit, Sumsub, and Persona on Canton 3.4. The mainnet deployment migrated to the Pure CIP #204 surface (DAR v2.1.0, package id `562bbc757d5ec55fba320bf7370588b356811b3f2556817f49098de467758ea4`) in the same window the SDK was open-sourced.

## Motivation

The Canton ecosystem currently has no canonical pattern for KYC and verifiable credentials. Each firm that needs identity primitives on Canton today must (a) build the KYC-vendor integration layer from scratch, (b) negotiate per-firm KYC partner contracts (Onfido, Sumsub, Persona), and (c) design an ad-hoc wire format and verification protocol with no interoperability guarantee.

CIP #204 names the standard at the chain boundary. `canton-vc` provides the rest of the stack — a vendor-neutral SDK, DAML templates implementing the CIP #204 interface, and three production adapters — so that three classes of Canton participants can build on shared infrastructure instead of inventing it independently.

**Identity-provider-style firms** (Crivacy.io is the first such deployment, but the same primitives are open to any new entrant) can build issuer infrastructure with a vendor-neutral KYC adapter layer, on-chain audit replay via content-addressed proof schemas, and a standardized OAuth/OIDC wire format — without rewriting the credential layer per KYC vendor and without inventing a bespoke claim schema.

**dApp / DeFi / NFT / lending verifiers** can accept credentials from any conforming identity provider with a single `verifyDisclosure()` call. No per-issuer integration code, no KYC partner contract on the verifier's side, and no in-house KYC infrastructure to operate. Trust is anchored cryptographically against the Canton sequencer's signature, not against the issuer's word — a tampered or fabricated disclosure blob is rejected by the verifier's own Canton participant before the verification choice body runs.

**Regulated finance institutions** running their own KYC pipelines on Canton benefit from on-chain audit replay (content-addressed proof schemas let an auditor recompute the on-chain hash from retained raw bytes years after the mint), multi-vendor adapter flexibility (a KYC-vendor swap is a label change in the credential's `claims` TextMap under the issuer's reverse-DNS namespace per CIP #204, not a re-implementation or DAR upgrade), and an open-source surface so internal security teams can audit the full stack instead of trusting a closed vendor.

The reusable "verify once, use everywhere" property that some identity providers market to their end users is delivered by the ecosystem of issuers + verifiers adopting CIP #204 — `canton-vc` is the infrastructure layer that makes that ecosystem possible without forcing every participant to ship the same primitives independently. The code in this repository has been exercised against a working Canton mainnet deployment before being extracted into the open-source workspace; every wire field, every DAML choice, every retry path, and every `DisclosedContract` blob shape has been touched by real ledger state, not just synthetic test runs.

## Specification

### 1. Objective

Deliver an Apache 2.0 reference SDK and DAML template set that lets any Canton-deployed firm (a) issue KYC verifiable credentials from any of the three most common KYC vendors today, (b) hold those credentials as on-chain CIP #204 credentials with optional soulbound `KycNFT` companions, and (c) verify a holder's credential via Canton's `DisclosedContract` mechanism without becoming a contract stakeholder. Ship as the first production reference implementation of CIP #204 so independent implementations of the standard can be validated against a running mainnet deployment.

### 2. Implementation Mechanics

The repository at https://github.com/Farukest/canton-vc contains the following packages, all Apache 2.0, all green on tsc and vitest at the day of submission.

`@canton-vc/core`: Canton JSON Ledger v2 client. Config plus Zod schemas for every endpoint, command builders for `createCredential` (joint signatory mint), `Credential_PublicFetch` (CIP #204 interface choice), `Credential_ArchiveAsHolder` (CIP #204 interface choice), `RevokeCredential`, `UpdateCredentials`, `createKycNft`, and standalone `BurnNft`. Per-contract `DisclosedContract.templateId` resolver so credentials minted under one package id remain verifiable after a participant upgrade. The `createClaimSchema(namespace, keys)` factory builds typed reverse-DNS claim-key registries per CIP #204 §Namespacing.

`@canton-vc/credential`: OAuth 2.0 + OIDC client plus the `verifyDisclosure(claims, { canton, actor, expectedAdmin })` helper. A firm holding the `canton_vc_credential_blob` and `canton_vc_contract_id` claims from an issuer's userinfo endpoint verifies the credential on its own Canton participant in a single call. The participant runs the `Credential_PublicFetch` choice body (CIP #204, nonconsuming) with chain time; the implementer asserts `expectedAdmin == admin` inside the body so a substituted credential is rejected at the chain boundary, not silently.

`@canton-vc/kyc-provider`: Vendor-agnostic `KycProvider` interface that decouples the issuer pipeline from any specific KYC vendor.

`@canton-vc/adapter-didit`: Production adapter wrapping Didit (v3 sessions API, HMAC-SHA256 webhook signatures over canonical JSON). Live in the reference deployment, and verified end-to-end against the real Didit API and a Canton 3.4 participant via `scripts/live-didit-canton-e2e-v2.ts` — 16-phase mainnet smoke exercising the same DAML-choice matrix as the other two adapters (`createCredential`, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` with NFT cascade, `UpdateCredentials`, `createKycNft`, standalone `BurnNft`, wrong-admin reject path).

`@canton-vc/adapter-sumsub`: Production adapter wrapping Sumsub (applicants API, per-request HMAC over `ts + method + path + body`, multi-algorithm webhook digest). Verified end-to-end against the real Sumsub API and a Canton 3.4 participant via `scripts/live-sumsub-canton-e2e-v2.ts` — 16-phase mainnet smoke exercising every DAML choice (`createCredential` across all claim levels, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` with NFT cascade, `UpdateCredentials`, `createKycNft`, standalone `BurnNft`, wrong-admin reject path).

`@canton-vc/adapter-persona`: Production adapter wrapping Persona (JSON:API inquiry endpoints, Bearer auth with pinned `Persona-Version`, signed-timestamp `Persona-Signature` webhook scheme with multi-secret key rotation, hosted one-time-link inquiry flow). Verified end-to-end against the real Persona API and a Canton 3.4 participant via `scripts/live-persona-canton-e2e-v2.ts` — the same 16-phase mainnet smoke executed against Persona's sandbox. The three adapters together cover the three most common KYC-vendor authentication patterns; community contributors for Onfido, Veriff, Au10tix, or Jumio inherit an interface validated against three structurally different vendors plus a vetted Pure CIP #204 chain-side surface.

`@canton-vc/adapter-mock`: Deterministic adapter for tests and local development, no network calls.

`daml/canton-vc-credential`: DAML package implementing CIP #204. The `Canton.VC.Credential` template implements the `Cip204.Standard.Credential` interface verbatim — view shape (`issuer / holder / admin / claims : TextMap Text / createdAt / expiresAt / meta`), joint signatories (`issuer + holder`), and the two standard choices (`Credential_PublicFetch` nonconsuming, `Credential_ArchiveAsHolder` consuming). Three implementer extensions live on the template outside the interface surface (`RevokeCredential` for issuer-side compliance with cascade NFT burn, `UpdateCredentials` for bulk claims refresh + `canton-vc/update.reason` meta stamp) plus the optional `KycNFT` companion + standalone `BurnNft` choice. DAR v2.1.0 is pre-built and shipped at `daml/canton-vc-credential/release/canton-vc-credential-2.1.0.dar` for direct upload to any Canton participant.

**Vendor-agnostic call site.** The `KycProvider` interface is the load-bearing abstraction. Switching the issuer's KYC vendor is a one-constructor-line change; the rest of the pipeline (decision normalisation, on-chain mint, disclosure verification) is untouched:

```typescript
// Same call site across all three vendors.
const provider: KycProvider =
  vendor === 'didit'
    ? new DiditAdapter({ apiKey, kycWorkflowId, addressWorkflowId, webhookSecret })
  : vendor === 'sumsub'
    ? new SumsubAdapter({ appToken, secretKey, identityLevelName, addressLevelName, webhookSecret })
    : new PersonaAdapter({ apiKey, identityTemplateId, addressTemplateId, webhookSecret });

const session = await provider.startSession({ userRef, workflow: 'identity' });
// → user completes the vendor-hosted flow at session.redirectUrl

const decision = await provider.fetchDecision(session.sessionId);
// → KycDecision with normalised shape:
//   evidence.{identityVerified, livenessVerified, addressVerified}
//   proofHash + proofSchemaId (vendor-derived SHA-256 over canonical JSON of a named-field payload)
//   level ('basic' | 'enhanced') + status + declineReason

// Joint-signatory mint per CIP #204 — actAs carries both parties.
await canton.createCredential({
  issuerParty,
  holderParty,
  adminParty,                         // disclosure authority asserted by verifiers
  claims: {
    values: ISSUER_CLAIM_SCHEMA.fromDecision(decision),   // typed reverse-DNS map
    validFrom: decision.validFrom,
    validUntil: decision.expiresAt,
    meta: { 'canton-vc/issued.by': vendor },
  },
});
```

Multi-step KYC (identity + proof-of-address) composes from two `startSession` calls with different `workflow` values. Workflow-level enums (`'identity' | 'address'`) hide the vendor-specific identifiers (Didit `workflow_id` UUIDs vs Sumsub `levelName` strings) behind the same call shape. The claim map's reverse-DNS namespace (the Crivacy reference deployment uses `io.crivacy/*`) is registered once via `createClaimSchema()` and reused at every mint.

**End-to-end verification.** All three adapters are verified end-to-end against the real vendor APIs AND a real Canton 3.4 mainnet participant. The repository ships live scripts that exercise the full DAML choice surface per vendor:

- `scripts/live-didit-canton-e2e-v2.ts` — 16-phase mainnet smoke: DiditAdapter session → human-in-the-loop identity verification at the hosted URL → poll-to-terminal approval → mint (4 credentials at varying claim levels) → `Credential_PublicFetch` × 4 → `Credential_ArchiveAsHolder` (holder-side withdrawal) → `RevokeCredential` with `KycNFT` cascade burn → `UpdateCredentials` (bulk claims refresh) → `createKycNft` → standalone `BurnNft` → wrong-admin reject path.
- `scripts/live-persona-canton-e2e-v2.ts` — same 16-phase shape against Persona's sandbox inquiry API.
- `scripts/live-sumsub-canton-e2e-v2.ts` — same 16-phase shape against Sumsub's officially supported `testCompleted` sandbox endpoint.

Each script reads real values from real APIs (no mocks, no reference-deployment code path), so the `proofHash` that ends up in the on-chain `claims` map is the same digest the vendor data produced, and the participant re-authenticates the disclosure blob against the sequencer signature before any verifier reads from it.

**Audit-replay pipeline.** The on-chain `proofHash` is a SHA-256 over a deterministic canonical JSON of a named-field identity payload, carried as a string entry in the credential's `claims` TextMap under the issuer's reverse-DNS namespace. The set of fields and their order are pinned by a content-addressed `ProofSchemaSpec`; the spec's own hash is written to the credential as `proofSchemaId` in the same claims map. Two contracts cannot share a hash unless they share a schema, and the schema itself is published verbatim in `docs/proof-schemas/<id>.json`.

A regulator (or the issuer's own auditor) loads the firm's retained raw bytes, applies `@canton-vc/core#canonicalJson` (`sortKeys + shortenFloats + JSON.stringify`) over the fields the schema names in the order it names them, takes the SHA-256, and compares against the on-chain `proofHash`. A mismatch means either the retained bytes drifted (firm-side issue) or the wrong schema id was used (caller error); the test never silently passes on the wrong inputs.

The hash input contains PII (`firstName`, `lastName`, `dateOfBirth`, `documentNumber`, …) but only as input to a one-way function — the on-chain output is a 64-character hex digest from which no PII is recoverable. Vendor-side opaque ids (`sessionId` / `applicantId` / `inquiryId`) in the input act as salts that defeat brute-force / rainbow-table attacks against the low-entropy identity fields alone.

**Operator design constraints.** The SDK exposes verification primitives; orchestration is left to the operator. The following constraints document where the line falls so committee review can audit the surface without reading source.

1. **The companion KycNFT is optional and outside the CIP #204 interface.** A credential is fully functional on its own — `Credential_PublicFetch` returns the complete view whether or not a soulbound `KycNFT` exists. The SDK exposes `createKycNft` as a separate call the issuer opts into; the DAML template's `ensure` clause permits NFT mints only on `level == "Enhanced"`, so Basic-tier credentials are NFT-ineligible at the chain boundary.
2. **Vendor swap is a label change in the `claims` TextMap, not a DAR upgrade.** Per CIP #204 §Namespacing, the validator identifier is carried as a free-form text claim under the issuer's reverse-DNS namespace (e.g. `io.crivacy/validator = 'DiditValidator'`). Existing credentials minted under one vendor remain valid through `Credential_PublicFetch` indefinitely after the issuer switches vendors. Three migration patterns are supported: replace, stack, and soft-rotate. The SDK enforces none of these; the issuer's policy choice.
3. **No PII reaches the chain.** Every value in the on-chain `claims` map is non-PII by construction: `userRef` is an opaque firm-side identifier, `proofHash` is a one-way SHA-256 digest, `proofSchemaId` is the content-addressed hash of the schema spec, and the remaining fields are enums, booleans, integers, or network labels rendered as strings. PII enters the hash input only and is non-recoverable from the on-chain digest.
4. **Audit replay is deterministic across runtimes.** The canonical pipeline (`shortenFloats` + `sortKeys` + `JSON.stringify`) is fully specified in `@canton-vc/core#canonicalJson`. An auditor in any language that produces identical bytes from `(spec.fieldsInOrder, retained raw values)` will derive the same `proofHash` the issuer wrote to chain. The schema is content-addressed and published at `docs/proof-schemas/<id>.json` — a regulator who only knows the `proofSchemaId` can fetch the full spec from the public registry and execute the audit without further coordination with the issuer.
5. **Adding a new vendor is a community PR.** A new adapter is an npm package implementing `KycProvider` (three methods: `startSession`, `fetchDecision`, `verifyWebhook`). New vendors register a stable validator label string in their adapter's README; no DAR upgrade is required because the validator value lives as a claim in the CIP #204 `claims` TextMap. Milestone 4 of this grant pays per-unit for accepted community adapter PRs.
6. **Workflow selection is enum-typed.** `startSession({ workflow: 'identity' | 'address' })` selects between the issuer's identity-only and proof-of-address workflows. Multi-step KYC composes by the issuer chaining the two and combining the resulting evidence flags + proof hashes at mint time.
7. **Re-mint and revocation are explicit operations.** Repeat KYC reuses the same `createCredential` and `revokeCredential` primitives. The implementer-extension `RevokeCredential` choice (controller: issuer) cascades to a bound NFT in the same transaction when the issuer passes `nftContractId`. The CIP #204 standard `Credential_ArchiveAsHolder` choice (controller: holder) lets the holder withdraw their own credential without involving the issuer. `UpdateCredentials` (controller: issuer) is a bulk claims-refresh path — archive current + create sibling with the new `claims` map + `canton-vc/update.reason` meta stamp — for the case where a re-KYC produces materially new data without changing the holder identity.
8. **`userRef` is verifier-correlatable by construction.** Issuers SHOULD use credential-scoped random pseudonyms rather than stable customer-DB identifiers. Issuing the same `userRef` to multiple verifiers exposes holders to cross-verifier correlation when verifiers collude or hold side-channel data on the holder. CIP #204 does not enforce a particular pseudonym scheme — issuer policy choice — and the verifier-side helper `userRefLooksLikePseudonym()` in `@canton-vc/credential` provides an opt-in heuristic check for verifiers that want to flag stable identifiers.
9. **Webhook trust is single-channel by default.** A KYC vendor's HMAC signature on a webhook is necessary but not sufficient for a high-assurance issuer pipeline — a compromised webhook secret lets an attacker forge an "approved" payload and trick the issuer into minting a credential against a user who never completed real verification. Issuers SHOULD implement dual-channel reconciliation (re-fetch via `provider.getDecision()` REST after every webhook) plus a periodic reconciliation worker that cross-checks non-terminal local state against the vendor's REST API. The threat model, pseudocode, and recommended cadence are documented in `docs/security-considerations.md` §1; the Crivacy.io reference deployment runs this pattern against Canton mainnet.
10. **Custom adapter authors are responsible for security correctness.** The `KycProvider` interface is structurally enforced by TypeScript but does not enforce that signature verification, replay protection, or `proofHash` computation are implemented correctly inside a new adapter. Adapter authors SHOULD copy the test file from the shipped adapter closest in shape (Didit for body-HMAC, Sumsub for prefixed-HMAC, Persona for signed-timestamp HMAC), reuse the canonical `computeProofHash()` export from `@canton-vc/core` rather than re-implementing the hash, and pick a stable validator label string documented in the adapter's README. The full checklist is in `docs/security-considerations.md` §2.

**Firm integration flow.** Two roles touch `canton-vc` at six concrete call sites, none requiring custom wire code or chain-side patches:

*Issuer side* (mints credentials):

1. **Start session** — `provider.startSession({ userRef, workflow: 'identity' | 'address' })` returns a vendor-hosted `redirectUrl` the issuer presents to the user.
2. **Receive decision** — either webhook-driven (`provider.verifyWebhookSignature(rawBody, headers)` then body parse) or pull-driven (`provider.fetchDecision(sessionId)`). Both yield the same vendor-agnostic `KycDecision` (status, level, evidence flags, proofHash, proofSchemaId, expiresAt).
3. **Mint on chain** — `canton.createCredential({ issuerParty, holderParty, adminParty, claims: { values, validFrom, validUntil, meta } })` creates a `Canton.VC.Credential` contract under joint signatory (`issuer + holder`) per CIP #204. The `claims.values` TextMap carries every field of interest (`proofHash`, `proofSchemaId`, `level`, `validator`, evidence flags, …) under the issuer's reverse-DNS namespace. Optional `canton.createKycNft(...)` mints the Enhanced-tier soulbound companion.
4. **Expose via OAuth** — the issuer's existing OAuth/OIDC userinfo endpoint emits `canton_vc_credential_blob` (the contract's `createdEventBlob`) and `canton_vc_contract_id` when the `canton-vc` scope is granted, alongside the existing `kyc:*` claims.

*Verifier side* (consumes credentials, never becomes a stakeholder):

5. **Receive claims** — verifier completes the OAuth flow against the issuer and reads the `canton_vc_*` claims from the userinfo response.
6. **Verify on own participant** — `verifyDisclosure(claims, { canton, actor, expectedAdmin })` from `@canton-vc/credential` attaches the blob as a `DisclosedContract`, exercises the CIP #204 `Credential_PublicFetch` nonconsuming interface choice on the verifier's own Canton participant, and returns the full view (issuer / holder / admin / claims TextMap / createdAt / expiresAt / meta). The participant re-authenticates the blob against the sequencer signature before the choice body runs; a tampered or fabricated blob is rejected with `DISCLOSED_CONTRACT_AUTHENTICATION_FAILED`. The implementer's `assertMsg expectedAdmin == admin` guard inside the choice body rejects substituted credentials at the chain boundary. Validity is derived from `claims.values + createdAt + expiresAt` against chain time via `isWithinValidityWindow(view)` — the verifier trusts the sequencer, not the issuer.

The same six call sites are exercised end-to-end by the live scripts above and by `examples/issuer-demo` + `examples/verifier-demo` against the mock vendor + a mock `CantonClient`. No reference-deployment branches, no Crivacy-specific code paths.

### 3. Architectural Alignment

Canton's stakeholder model gives selective disclosure by default: a contract is visible only to its stakeholders. CIP #204 leverages this by making the credential a contract whose joint signatories are `issuer + holder` and whose disclosure surface is mediated by the `admin` party. The `DisclosedContract` mechanism then lets the issuer (acting on behalf of the holder) hand a self-authenticating blob to a third party that is not a stakeholder; that party's participant re-derives the contract id from the blob, checks the sequencer signature, and runs the nonconsuming `Credential_PublicFetch` choice on the contract. A tampered or fabricated blob is rejected with `DISCLOSED_CONTRACT_AUTHENTICATION_FAILED` before the choice body executes, so the verifying firm trusts the network's cryptographic primitives rather than the issuer.

`canton-vc` uses this pattern directly. The credential lives on chain as a `Canton.VC.Credential` contract implementing the `Cip204.Standard.Credential` interface. The `Credential_PublicFetch` interface choice returns the view struct computed server-side from contract fields and the current ledger time; the implementer asserts `expectedAdmin == admin` inside the body so a verifier cannot be tricked into accepting a credential issued under a different admin authority. The OAuth/OIDC userinfo response is a delivery vehicle for the blob plus the contract id; it is not the source of truth.

This positions `canton-vc` as a foundational piece of the Canton Network identity stack: vertical KYC issuers (insurance, capital markets, lending) compose against the same CIP #204 interface and the same TypeScript verifier surface, with the standard defining the wire-format guarantees that hold across implementations.

### 4. Backward Compatibility

CIP #204 is the wire-format contract. New implementations of `Cip204.Standard.Credential` interoperate at the chain boundary regardless of their implementer-extension surface — a verifier built against this SDK can verify a credential minted by an unrelated DAML implementation of the same interface, and vice versa.

The implementer-extension surface (`RevokeCredential`, `UpdateCredentials`, `KycNFT`, `BurnNft`) is governed locally and tagged with the `canton-vc/` meta prefix where it crosses into the view payload (e.g. `canton-vc/update.reason` on `UpdateCredentials`). Future additions to this surface follow the local governance process documented in [`GOVERNANCE.md`](../GOVERNANCE.md) §2 and require a major version bump on `canton-vc-credential` (DAML) and `@canton-vc/core` + `@canton-vc/credential` (TS).

Mainnet swap: the Crivacy.io reference deployment migrated to the Pure CIP #204 surface at DAR v2.1.0 in May 2026, with the prior pre-CIP-204 DAR permanently unvetted on the same participant. Existing on-chain contracts under the prior DAR remain queryable for audit lookup against their original package id but no new mints land there.

The OAuth claim names (`canton_vc_credential_blob`, `canton_vc_contract_id`) and the scope name (`canton-vc`) are namespaced under `canton_vc_*` to prevent collision with other Canton extensions and unrelated OAuth deployments. Application-specific fields (`userRef`, `level`, `validator`, …) live inside the CIP #204 `claims` TextMap under the issuer's reverse-DNS namespace, not in OAuth claim names.

## Milestones and Deliverables

### Milestone 1: Open-source release — already-delivered acceptance

**Hard deadline:** Funding released on grant approval against the present-state artefacts (already in the repository at submission).
**Funding:** 400,000 CC (~27%)
**Engineering basis:** Approximately six months of production engineering at [Crivacy.io](https://crivacy.io) running the Canton credential pattern (estimated ~900 person-hours of already-delivered engineering across the SDK, DAR, and integration surface), plus several focused weeks of extraction, hardening, and standardisation work — including the Pure CIP #204 migration of both the open-source DAR and the production mainnet deployment — to turn that internal codebase into a vendor-neutral, audit-replay-ready open-source SDK + DAR + reference implementation.
**Person-hours:** ~900 already-delivered + ~10 of remaining release-polish work (npm publish, repository plumbing, tagged release commit).

Deliverables, all currently in the repository at submission time:

- Apache 2.0 release of seven npm packages: `@canton-vc/core` (incl. content-addressed proof-schema infrastructure + CIP #204 command builders + `createClaimSchema()` factory), `@canton-vc/credential` (incl. `verifyDisclosure({ actor, expectedAdmin })`), `@canton-vc/kyc-provider`, `@canton-vc/adapter-didit`, `@canton-vc/adapter-sumsub`, `@canton-vc/adapter-persona`, `@canton-vc/adapter-mock`. All packages at v0.2.0.
- Public proof-schema registry at `docs/proof-schemas/<id>.json` for each adapter (content-addressed; on-chain `proofSchemaId` resolves to the published spec).
- Public GitHub repository with LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, GOVERNANCE, CHANGELOG, and SECURITY policies.
- First production reference implementation of [CIP #204](https://github.com/canton-foundation/cips/pull/204) — `Canton.VC.Credential` implements `Cip204.Standard.Credential` verbatim. Cross-linked from the repository README and from the CIP #204 PR thread.
- DAML DAR pre-built and committed at `daml/canton-vc-credential/release/canton-vc-credential-2.1.0.dar` (Canton 3.4 compatible, LF 2.2). Mainnet package id: `562bbc757d5ec55fba320bf7370588b356811b3f2556817f49098de467758ea4`.
- Two runnable reference apps under `examples/`: `examples/issuer-demo/` (Node CLI exercising `startSession` → `fetchDecision` → `createCredential`) and `examples/verifier-demo/` (Vite + React SPA exercising `verifyDisclosure()` end-to-end plus a `KycNFT` cascade-revoke panel). Both run in 30 seconds against a mock vendor + in-memory Canton mock with zero credentials; both also support a real KYC vendor sandbox mode (Didit / Sumsub / Persona) via `.env` — the CLI uses the adapters directly, the SPA proxies through a co-located Node-side `vendor-server.ts` so HMAC secrets and API keys stay out of the browser bundle. Smoke-verified end-to-end against the live Didit + Sumsub + Persona sandbox APIs during pre-submission testing.
- CI matrix covering typecheck, lint, and vitest across Node 20 and 22 on Linux, macOS, and Windows.

**Acceptance criteria:** Packages installable from npm under `@canton-vc/*` at v0.2.0. CI green at the tagged release commit. Repository README links the CIP #204 implementation status and the mainnet package id, with a cross-link comment on the CIP #204 PR thread tagging this implementation as a reference. Plus a first Foundation-side acknowledgment within the milestone window — either a comment on the CIP #204 thread from the Tech & Ops Committee or a champion ack in the Regulatory Compliance / Identity & Metadata SIG channel.

**Production reference (on-chain verifiable):** [Crivacy.io](https://crivacy.io) has been running the canton-vc credential pattern in production on Canton mainnet since November 2025, with the Pure CIP #204 surface live since May 2026. The credential-issuing DAML operator is party [`CrivacyOperator::1220a37e50a4f650bcd0554c2fca064b59c3444eebd0383dbaaa65a2cc137bedc524`](https://ccview.io/party/CrivacyOperator::1220a37e50a4f650bcd0554c2fca064b59c3444eebd0383dbaaa65a2cc137bedc524/), running on the validator [`crivacy-validator-1::1220a37e50a4f650bcd0554c2fca064b59c3444eebd0383dbaaa65a2cc137bedc524`](https://ccview.io/validators/crivacy-validator-1::1220a37e50a4f650bcd0554c2fca064b59c3444eebd0383dbaaa65a2cc137bedc524/) (same participant, two parties). The active mainnet DAR is `canton-vc-credential` v2.1.0 (package id `562bbc757d5ec55fba320bf7370588b356811b3f2556817f49098de467758ea4`, deployed 2026-05-28) — the same DAR shipped in the repository's `release/` directory. The pre-CIP-204 predecessor DAR is permanently unvetted on mainnet; existing on-chain contracts under it remain queryable for audit lookup against their original package id.

### Milestone 2: External security audit

**Hard deadline:** 1 month from grant approval.
**Funding:** 300,000 CC (20%). Target audit vendor: [Cure53](https://cure53.de/) or comparable firm with DAML and TypeScript audit experience; final scope and vendor to be approved with the Tech & Ops security subcommittee before kickoff. Expected vendor fee: $24-30k (160-200K CC pass-through). Remainder covers engineering remediation and final report integration.
**Person-hours:** ~80 (audit coordination + remediation)

Deliverables:

- External security audit by Cure53, scope reviewed with the Tech & Ops security subcommittee before kickoff.
- Audit scope: `@canton-vc/core` (Canton JSON Ledger v2 client), the DAML templates (`canton-vc-credential` package — `Cip204.Standard.Credential` implementation including `Credential_PublicFetch` and `Credential_ArchiveAsHolder` interface choices, plus the implementer extensions `RevokeCredential`, `UpdateCredentials`, `KycNFT` + `BurnNft`), and `verifyDisclosure({ actor, expectedAdmin })` in `@canton-vc/credential` (DAML + TypeScript boundary).
- Audit report published alongside the Milestone 2 release with all critical and high findings remediated.
- DAR rebuilds verified against the latest stable Canton release (currently 3.4) and the next stable Canton release if it lands during the milestone window (3.5 is in release-candidate as of submission).

**Acceptance criteria:** Cure53 audit report public with no unresolved critical or high findings. DAR builds verified on Canton 3.4, plus any later stable Canton release published during the milestone window.

### Milestone 3: Python SDK port + multi-language roadmap

**Hard deadline:** 2 months from grant approval.
**Funding:** 350,000 CC (23%)
**Person-hours:** ~120 (intensive solo Python port)

Deliverables:

- `canton-vc` Python package with feature-parity to the TypeScript `@canton-vc/core` and `@canton-vc/credential`: Canton JSON Ledger client, OAuth 2.0 + OIDC helpers, `verify_disclosure()` helper exercising the CIP #204 `Credential_PublicFetch` interface choice. Pydantic validation, same wire layer as the TypeScript packages, idiomatic snake_case API.
- Published to PyPI under Apache 2.0 as `canton-vc`.
- Issuer cookbook and verifier cookbook covering the Python integration path.

**Acceptance criteria:** Python package installable from PyPI with green CI on Python 3.10, 3.11, and 3.12. Feature parity with the TypeScript surface validated by a shared integration test suite running against a Canton participant.

**Roadmap beyond Milestone 3:**

| Language | Status | Where |
|---|---|---|
| TypeScript / JavaScript | ✓ Shipped | Milestone 1 (this proposal) — `@canton-vc/*` on npm |
| Python | Planned | Milestone 3 (this proposal) — `canton-vc` on PyPI |
| Go | Planned | Phase 2 continuation grant |
| Java | Planned | Phase 2 continuation grant |
| Rust | Planned | Phase 2 continuation grant |
| .NET (C#) | Planned | Phase 2 continuation grant |

### Milestone 4: Adoption (per-unit pricing)

**Hard deadline:** 4 months from grant approval.
**Funding:** Up to 450,000 CC (30%), priced per achieved sub-KPI plus a completion lump.
**Person-hours:** ~60 (community support, PR review, integration support).

Sub-KPIs and unit pricing:

- 80,000 CC per accepted community adapter PR (target vendors: Onfido, Veriff, Au10tix, Jumio). Maximum 2 sub-KPI awards (up to 160K).
- 80,000 CC per second-issuer integration, meaning an operator outside the reference deployment running canton-vc to mint Canton credentials. Maximum 1 award (up to 80K).
- 80,000 CC per verifier-firm integration consuming `verifyDisclosure()` against any canton-vc issuer. Maximum 1 award (up to 80K).
- 130,000 CC completion lump on Milestone 4 close, contingent on at least one sub-KPI achieved + repository in maintained state (responded issues, merged PRs, green CI).

Unspent CC at milestone close returns to the development fund. The per-unit structure was chosen because adoption is the dimension where outcomes are least predictable from engineering effort alone; the completion lump rewards the engineering effort of supporting integrators even when adoption ramps slowly.

**Acceptance criteria:** Each sub-KPI is validated through the on-chain trail or the merged PR in `Farukest/canton-vc`. The committee or its delegate confirms each unit award against the published evidence.

### Ongoing: Maintenance (Post-Grant)

**Hard deadline:** Begins on M4 acceptance and runs for 24 months.
**Funding:** Covered by the M4 completion lump; no additional grant ask.
**Scope:**

- Security patches across `@canton-vc/*` npm packages and the `canton-vc-credential` DAR (rebuilds against new stable Canton releases, dependency-pin updates, vendor-adapter API drift fixes).
- Tracking upstream revisions to [CIP #204](https://github.com/canton-foundation/cips/pull/204) — if the standard's view shape or choice signatures change after this implementation ships, the DAR is updated to match within one minor release.
- Community PR triage and review on `Farukest/canton-vc` (vendor adapter contributions per the Milestone 4 sub-KPI, bug reports, doc improvements).
- `SECURITY.md` vulnerability response process — coordinated disclosure window, patch turnaround, and credit policy following the OWASP / CVE-aligned standard the Foundation already uses for other ecosystem packages.

If material maintenance effort emerges beyond this 24-month window (e.g., a major Canton protocol bump that requires a non-trivial DAR rewrite, or a security audit finding outside the Cure53 / M2 scope), a separate Maintenance & Compatibility Extension proposal would be submitted through the Foundation's standard channel. The reference deployment running this code in production ensures the maintenance window is exercised against real ledger state rather than synthetic tests.

## Funding

| Line item | Milestone 1 | Milestone 2 | Milestone 3 | Milestone 4 | Total |
|---|---|---|---|---|---|
| Retroactive recognition of delivered work | 400K | — | — | — | 400K |
| External security audit (vendor + remediation) | — | 300K | — | — | 300K |
| Python SDK port engineering | — | — | 350K | — | 350K |
| Adoption support (per-unit + completion lump) | — | — | — | up to 450K | up to 450K |
| **Subtotal** | **400K** | **300K** | **350K** | **up to 450K** | **up to 1,500K** |

Funding is released after each milestone is accepted by the Tech & Ops Committee against the acceptance criteria above. Unspent CC at milestone close returns to the development fund. Milestone 4 sub-KPIs are paid individually as each is achieved within the milestone deadline.

## Champion

This proposal is championed by the Canton Foundation. The repository at https://github.com/Farukest/canton-vc, the CIP #204 PR thread, and the mainnet on-chain trail are the primary review surface.

## Co-Marketing

On acceptance of Milestone 1, the author will coordinate with the Canton Foundation marketing team on:

- A launch announcement covering the open-source release and the CIP #204 reference implementation via the Foundation's channels.
- A dApp Leaders Forum talk or recorded session walking through the SDK integration path (issuer + verifier) against the CIP #204 surface.
- A reference-architecture blog post co-published with the Foundation describing the disclosed-contract verification pattern under CIP #204.

The author will tag the Canton Foundation in repository milestones (CHANGELOG releases, CIP #204 cross-links, milestone closures) so the Foundation can amplify on its own schedule.
