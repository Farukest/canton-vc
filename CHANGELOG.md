# Changelog

All notable changes to `canton-vc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Initial open-source release of `canton-vc`. Apache 2.0 across all packages.
- `@canton-vc/core` — Canton JSON Ledger v2 client (wire layer): config + Zod schemas, command builders for `CreateKycCredential` / `Verify` / `RevokeCredential` / `CreateKycNft`, retry-aware fetch, party parsing, per-contract `DisclosedContract.templateId` resolver for credentials that outlive a package upgrade.
- `@canton-vc/credential` — high-level OAuth 2.0 / OIDC client + `verifyDisclosure()` helper.
- `@canton-vc/kyc-provider` — vendor-agnostic `KycProvider` interface decoupling the issuer pipeline from any specific KYC vendor.
- `@canton-vc/adapter-didit` — production adapter wrapping the Didit v3 sessions API + HMAC-SHA256 webhook signature scheme (canonical JSON, `X-Signature-V2`, 5-minute drift window).
- `@canton-vc/adapter-sumsub` — production adapter wrapping the Sumsub applicants API. Implements Sumsub's per-request HMAC authentication scheme (signature over `ts + method + path + body`, sent in `X-App-Access-Sig`) plus the multi-algorithm webhook digest scheme (`X-Payload-Digest` with the algorithm selected by `X-Payload-Digest-Alg`, supporting SHA1 / SHA256 / SHA512). End-to-end verified against the real Sumsub API and a Canton 3.4 participant via `scripts/live-sumsub-canton-e2e.ts`.
- `@canton-vc/adapter-persona` — third production adapter (Persona inquiry API, JSON:API envelope, `Persona-Signature` HMAC-SHA256 webhook scheme with multi-secret key rotation, hosted one-time-link inquiry flow). End-to-end verified against the real Persona API (manual identity inquiry) and a Canton 3.4 participant — full chain including the `KycNFT` cascade-revoke path — via `scripts/live-persona-canton-manual-e2e.ts` and `scripts/live-persona-canton-mint-existing.ts`. Validates the `KycProvider` interface against a third structurally distinct vendor.
- `@canton-vc/adapter-mock` — deterministic adapter for tests and local development, no network calls.

  The three adapters (Didit, Sumsub, Persona) differ across auth scheme, identity model, workflow vocabulary, and webhook signature format, so shipping all three validates the `KycProvider` interface as vendor-agnostic in practice.

- `daml/canton-vc-credential` — DAML 3.4.11 package with the `Canton.VC.Credential` module + pre-built DAR shipped at `daml/canton-vc-credential/release/canton-vc-credential-1.1.0.dar` (package id `02806dc9e912f57a61ad83a0f8b300452baf4f734cd259d56458c9b1023d4421`).
- `@canton-vc/core` proof-hash module — content-addressed `ProofSchemaSpec` + canonical JSON pipeline (`sortKeys + shortenFloats + JSON.stringify + SHA-256`) + `computeProofHash(spec, values)` + `computeSchemaId(spec)`. Adapters declare a named-field schema; on-chain `proofHash` and `proofSchemaId` are derived together. Replaces the prior "hash whatever the vendor returns" placeholder; raw vendor blobs no longer leak schema drift into the digest.
- `Canton.VC.Credential` template v1.1.0: added `proofSchemaId : Optional Text` at the end of the template + view payload (DAML smart-contract upgrade rule). `ensure` clause enforces `Some <non-empty>` on every new mint; v1.0.0 contracts remain valid (and surface as audit-incomplete to downstream verifiers). DAR version 1.0.0 → 1.1.0; package id changed; both DARs coexist on the participant.
- `docs/proof-schemas/<id>.json` — public proof-schema registry for the three production adapters. Auditors look up the on-chain `proofSchemaId` here to learn which named fields were hashed and in what order, then replay the digest against the firm's retained raw bytes.
- `docs/cip-draft-canton-vc-standard.md` — first draft of the Canton Verifiable Credentials Standard CIP.
- `examples/issuer-demo` — runnable Node CLI exercising the issuer pipeline (`startSession` → `fetchDecision` → `createCredential`) against the mock vendor by default, or any of Didit / Sumsub / Persona sandbox APIs via `.env`. No Canton participant required; ships with an in-memory canton mock for the on-chain leg.
- `examples/verifier-demo` — runnable Vite + React SPA exercising the verifier surface end-to-end. Three panels (issue, verify, NFT cascade-revoke) drive the real `verifyDisclosure()` helper against an in-memory canton mock. Default mode is mock-only (`pnpm dev` opens the SPA in 30 seconds, no credentials). Optional **real vendor sandbox mode**: pick Didit / Sumsub / Persona from the header dropdown and paste sandbox keys into `.env`; the SPA then drives the real `@canton-vc/adapter-*` adapters through a co-located `vendor-server.ts` Node proxy (HMAC signing, Persona-Version pinning, and Sumsub digest stay server-side — keys never reach the browser bundle).
- `proposals/canton-vc-sdk.md` — grant proposal for the Canton Foundation development fund (1,500,000 CC over 4 months).
