# Changelog

All notable changes to `@canton-vc/adapter-sumsub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.3.0] — 2026-05-29

### Changed

- Depends on `@canton-vc/core ^0.3.0` and `@canton-vc/kyc-provider ^0.3.0`. Adapter surface (`startSession`, `fetchDecision`, `verifyWebhook`, `parseWebhookEvent`) is byte-identical to v0.2.0 — Sumsub applicants API integration is unchanged.
- The companion live smoke `scripts/live-sumsub-canton-e2e-v2.ts` was updated to pass `holderParty` on the `updateCredentials` call (now mandatory in `@canton-vc/core` v0.3.0); phase 16 exercises the two-step factory pathway against DAR v2.2.0 on mainnet end-to-end — green at the tagged release commit.

[0.3.0]: https://github.com/Farukest/canton-vc/releases/tag/adapter-sumsub-v0.3.0

## [0.2.0] — 2026-05-28

### Changed

- Depends on `@canton-vc/core ^0.2.0` and `@canton-vc/kyc-provider ^0.2.0`. The adapter's `KycProvider.fetchDecision()` output now flows into the v0.2.0 SDK's `createCredential(claims)` pipeline against the CIP #204 `Canton.VC.Credential` template — `proofHash`, `level`, identity/liveness/address flags map into `claims.values` under the consumer's reverse-DNS namespace.

### Verified

- End-to-end live mainnet smoke against Sumsub sandbox (`sbx:` API key, `id-and-liveness` level) — 16 phases including `createCredential` × 4, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` with NFT cascade, `UpdateCredentials` (bulk refresh), `createKycNft`, and standalone `BurnNft`. All choices exercised on canton-vc-credential DAR v2.2.0 (`9eecc8d4... → 562bbc75...`) without skips.

### Notes

- Sumsub API surface (`POST /resources/applicants`, `GET /resources/applicants/:id/one`, webhook `X-App-Access-Sig`) unchanged. Existing webhook handlers and session-start payloads are byte-identical to v0.1.0.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/adapter-sumsub-v0.2.0
