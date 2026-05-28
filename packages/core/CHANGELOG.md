# Changelog

All notable changes to `@canton-vc/core` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.2.0] — 2026-05-28

### BREAKING — Pure CIP #204 alignment

The Canton wire layer was rewritten end-to-end to adopt the [Canton Verifiable Credentials Standard (CIP #204)](https://github.com/canton-foundation/cips/pull/204). Storage shape, choice surface, signatory model, and the exported types all changed. Consumers should migrate as a single step — no compatibility shim is shipped.

### Added

- **`createClaimSchema(namespace, keys)`** factory — generate a typed, frozen claim-key registry from a reverse-DNS namespace + list of short names. Replaces the per-key constant boilerplate previously written by hand at every call site.
- **`archiveAsHolder()`** — exercises the CIP #204 standard `Credential_ArchiveAsHolder` interface choice. Controller is the holder; returns the archived view plus caller-supplied metadata.
- **`burnNft()`** — standalone burn of a `KycNFT` companion contract, independent of the cascade burn that `revokeCredential` triggers when supplied with an NFT contract id.
- **`updateCredentials()`** — implementer-side bulk claims refresh. Archives the current contract and creates a sibling carrying the new claims map (and optionally a new `expiresAt`), preserving the contract identity in spirit. Stamps a caller-supplied reason onto the new sibling's meta under `canton-vc/update.reason`.
- New types: `ArchiveAsHolderInput/Result`, `BurnNftInput/Result`, `UpdateCredentialsInput/Result`, plus `CredentialView` reflecting the CIP #204 view shape (`admin, issuer, holder, claims, createdAt, expiresAt, meta`).
- `CIP204_INTERFACE_MODULE_AND_NAME` + `deriveCip204InterfaceId(packageName)` helper — derives the `Cip204.Standard:Credential` interface identifier from the configured template package name, used to address interface choices via `ExerciseCommand.templateId`.
- ACS query layer is now fault-tolerant — contracts created under a prior package version that no longer parses against the v2 shape are silently skipped instead of surfacing as a transport error.

### Changed

- `createCredential()` now uses joint signatories per CIP #204 — `actAs` carries both `issuerParty` and `holderParty`; both must be hosted on the submitting participant. The new `adminParty` field declares the disclosure-authority party that `Credential_PublicFetch` callers will check via `expectedAdmin`.
- `verifyCredential()` exercises the **`Credential_PublicFetch`** interface choice (nonconsuming) on the `Cip204.Standard.Credential` interface — `templateId` on the exercise command is the interface identifier, not the template identifier. The new `expectedAdmin` parameter is mandatory; the choice body asserts `expectedAdmin == admin` so substituted credentials are rejected at the chain boundary.
- Wire schemas updated to the structural CIP #204 shape: `claims : TextMap Text` replaces the previous flat root fields (`proofHash`, `level`, `validator`, etc.). Application fields live inside `claims.values` under the consumer's chosen reverse-DNS namespace per CIP #204 §"Namespacing".
- `CantonConfig.packageName` accepts both `#<name>:Module:Template` (package-name reference, upgrade-aware) and `<lf-hash>:Module:Template` (canonical hash) forms. `DisclosedContract.templateId` resolution to the canonical hash is now cached per (config, contract id) — handles the asymmetric Canton 3.4 V2 API behaviour.

### Removed

- **`Verify` choice wrapper** — replaced by `verifyCredential()` which exercises `Credential_PublicFetch`.
- **`MigrateValidator` command builder** — replaced by `updateCredentials()` for the same semantic.
- Application-layer enums (`KycLevel`, `CredentialStatus`, `Validator`, `CanonicalNetwork`) and the `DAML_TO_DB_*` / `DB_TO_DAML_*` mapping tables — these belong in consumer code, not the SDK. The SDK now stays agnostic of any specific issuer vocabulary.
- Flat root field shape on `Credential` (`operator/user/userRef/proofHash/level/...`) — collapsed into the CIP #204 structural shape.

### Fixed

- Disclosed-contract blob normalisation now correctly converts Canton base64url output to standard base64 before attachment, fixing `400 Invalid value for: body` rejections on cross-participant verifies.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/core-v0.2.0
