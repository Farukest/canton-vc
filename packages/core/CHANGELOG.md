# Changelog

All notable changes to `@canton-vc/core` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.3.0] — 2026-05-29

### Added — CIP #204 optional factory pathway

- **`buildCredentialFactoryUpdateExerciseCommand(config, input, commandId)`** — issues an `ExerciseCommand` targeting the CIP #204 `Cip204.Factory:CredentialFactory` interface id. Used as the second leg of the bulk-update orchestration: the first leg creates the implementer's joint-signatory `CredentialFactory` contract, the second leg runs `CredentialFactory_UpdateCredentials` on the interface against that contract id.
- **`deriveCip204FactoryInterfaceId(packageName)`** — derives `<pkg>:Cip204.Factory:CredentialFactory` from a configured template package reference (both `#<name>:Module:Template` and `<lf-hash>:Module:Template` forms supported).
- **`deriveCredentialFactoryTemplateId(packageName)`** — derives `<pkg>:Canton.VC.Credential:CredentialFactory` (the implementer template).
- `'updfac'` added to the `newCommandId` purpose union so the factory-create leg's command id is distinguishable from the subsequent update exercise in audit logs.

### Changed

- **`UpdateCredentialsInput`** gained `holderParty: PartyId` (required) and `adminParty?: PartyId` (optional, defaults to issuer). The factory choice is joint-controlled (issuer + holder); the SDK passes both via `actAs` on each of the two legs.
- **`updateCredentials()` orchestrator** rewritten as a two-step pipeline. Step 1 issues the factory `CreateCommand` and extracts the new contract id from the transaction events. Step 2 issues the `ExerciseCommand` on the CIP #204 factory interface id with a single-entry update list, extracting the new credential contract id from the second transaction's events. Each leg carries its own `op` context (`updateCredentials.createFactory` / `.exerciseFactory`) for trace clarity.
- **`buildUpdateCredentialsCommand`** is now first-leg-only — it issues the factory `CreateCommand`. Up-front input validation (claims, expiresAt, target contract id, reason) is preserved so callers fast-fail locally before the first round-trip.

### Why two steps

The JSON Ledger API's `CreateAndExerciseCommand` only addresses template-level choices, not interface choices on the template's implementations. The CIP #204 factory pattern exercises a choice on `Cip204.Factory:CredentialFactory` — an interface — so the choice exercise cannot be folded into the create command and must be a separate `ExerciseCommand` carrying the interface id in `templateId`. A v0.3.0-pre attempt at the single-command shape was rejected by Canton mainnet with `INVALID_ARGUMENT: Invalid template:…:Canton.VC.Credential:CredentialFactory or choice:CredentialFactory_UpdateCredentials`; the two-step split is the spec-correct resolution.

### Verified

- **Sumsub + Persona mainnet e2e** (DAR v2.2.0, package id `16fb51c2e9703cef173c76babd755afca9c7a01e34fc947aebc12205fdf0f719`) — phase 16 `updateCredentials` exercised end-to-end via the two-step path; old credential D archived, new sibling created with refreshed claims map + `expiresAt`; `Credential_PublicFetch` over the new contract confirms the updated view.
- 299/299 unit tests green (`vitest run`).

[0.3.0]: https://github.com/Farukest/canton-vc/releases/tag/core-v0.3.0

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
