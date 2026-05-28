# Changelog

All notable changes to `@canton-vc/adapter-persona` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.2.0] — 2026-05-28

### Changed

- Depends on `@canton-vc/core ^0.2.0` and `@canton-vc/kyc-provider ^0.2.0`. The adapter's `KycProvider.fetchDecision()` output now flows into the v0.2.0 SDK's `createCredential(claims)` pipeline against the CIP #204 `Canton.VC.Credential` template.

### Verified

- End-to-end live mainnet smoke against Persona sandbox (`persona_sandbox_*` API key, sandbox `Approve an Inquiry` endpoint) — 16 phases including `createCredential` × 4, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` with NFT cascade, `UpdateCredentials` (bulk refresh), `createKycNft`, and standalone `BurnNft`. All choices exercised on canton-vc-credential DAR v2.1.0 (`562bbc75...`) without skips.

### Notes

- Persona inquiry surface (`POST /api/v1/inquiries`, `meta.auto-create-one-time-link`, hosted-flow URL) unchanged. Existing webhook handlers and session-start payloads are byte-identical to v0.1.0.
- Sandbox auto-approve uses the official `POST /api/v1/inquiries/:id/approve` endpoint (requires a sandbox API key — `persona_sandbox_*`). Live keys reject the call.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/adapter-persona-v0.2.0
