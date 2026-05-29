# Changelog

All notable changes to `@canton-vc/credential` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.3.0] — 2026-05-29

### Changed

- Depends on `@canton-vc/core ^0.3.0`. No surface changes to `verifyDisclosure(claims, { canton, actor, expectedAdmin })`; the on-wire view shape returned by `Credential_PublicFetch` is byte-identical between DAR v2.1.0 and v2.2.0, so verifiers running this helper against either package id continue to work without code changes.

### Notes

- The DAR v2.2.0 factory pathway (`CredentialFactory_UpdateCredentials`) is an issuer-side concern — it lives in `@canton-vc/core`. Verifier flows are unchanged: a credential refreshed via the factory archives the prior contract and creates a sibling, and `verifyDisclosure` against the new sibling's disclosure blob returns the refreshed view via the same `Credential_PublicFetch` choice.

[0.3.0]: https://github.com/Farukest/canton-vc/releases/tag/credential-v0.3.0

## [0.2.0] — 2026-05-28

### BREAKING — `verifyDisclosure()` migrated to CIP #204 `Credential_PublicFetch`

`verifyDisclosure(claims, opts)` now exercises the standard CIP #204 `Credential_PublicFetch` interface choice on the consumer's own Canton participant. The opts signature changed: the previous single `fetcher` party is replaced by `{ actor, expectedAdmin }` — `actor` is the choice controller (your firm's Canton party); `expectedAdmin` is the disclosure-authority party shipped on the OAuth claim set, which the CIP #204 implementer asserts against the on-chain `admin` field. A wrong-admin probe aborts at the chain boundary, not silently.

### Added

- Canonical carried-claim key — the helper consumes `canton_vc_credential_blob` (CIP #204-aligned key name) from the claims object. Implementer-specific aliases are an integration concern: a verifier consuming an issuer that publishes the disclosure blob under a different key name can map it to `canton_vc_credential_blob` at the userinfo-parse boundary before calling `verifyDisclosure`.
- New typed errors: `disclosure_blob_missing`, `disclosure_contract_id_missing`, `wrong_admin` (the implementer assertion failure surfaces as a structured `CantonError`).

### Changed

- Depends on `@canton-vc/core ^0.2.0`. The on-wire shape consumed by `verifyDisclosure` matches the v0.2.0 Pure CIP #204 view (`admin/issuer/holder/claims/createdAt/expiresAt/meta`).
- Documentation example in `README.md` rewritten to show the `actor` + `expectedAdmin` two-parameter form plus reading application fields from `view.claims.values` under the consumer's reverse-DNS namespace.

### Removed

- Old `Verify` choice exercise path — the helper no longer attempts the legacy choice; consumers running an out-of-date issuer DAR must upgrade.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/credential-v0.2.0
