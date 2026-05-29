# Changelog

All notable changes to `@canton-vc/kyc-provider` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.3.0] — 2026-05-29

### Changed

- `peerDependencies` co-ordination with the breaking `@canton-vc/core ^0.3.0` line. `KycProvider` interface shape (`startSession`, `fetchDecision`, `verifyWebhook`, `parseWebhookEvent`) is byte-identical to v0.2.0 — existing adapter implementations continue to work; this bump exists so downstream adapters and consumers can pin a coherent `^0.3.0` range across the whole `@canton-vc/*` family.

[0.3.0]: https://github.com/Farukest/canton-vc/releases/tag/kyc-provider-v0.3.0

## [0.2.0] — 2026-05-28

### Changed

- `KycDecision.proofSchemaId` doc comment updated to reflect the `Canton.VC.Credential` template ensure-clause requirement — adapters MUST emit a non-empty proof-schema id; the on-chain template rejects empty/null on every mint regardless of issuer policy.
- Interface contract is otherwise stable — `KycProvider` shape (`startSession`, `fetchDecision`, `verifyWebhook`, `parseWebhookEvent`) unchanged. This bump is solely a `peerDependencies` co-ordination with the breaking v0.2.0 line.

### Notes

- No surface changes to the `KycProvider` contract. Existing adapter implementations continue to work — re-publishing the package allows downstream adapters and consumers to pin a coherent `^0.2.0` line across the whole `@canton-vc/*` family.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/kyc-provider-v0.2.0
