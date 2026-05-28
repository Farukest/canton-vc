# Changelog

All notable changes to `@canton-vc/adapter-didit` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.2.0] — 2026-05-28

### Changed

- Depends on `@canton-vc/core ^0.2.0` and `@canton-vc/kyc-provider ^0.2.0`. The adapter's `KycProvider.fetchDecision()` output is consumed by callers that mint Canton credentials against the v0.2.0 SDK surface — `proofHash`, `proofSchemaId`, and the evidence flags map cleanly into the CIP #204 `claims : TextMap Text` shape under the consumer's reverse-DNS namespace.
- Webhook-synth decisions now satisfy the v0.2.0 `KycDecision` invariants (non-empty `proofSchemaId`, structural validity) so a webhook-triggered mint succeeds against the `Canton.VC.Credential` template's ensure clause.

### Notes

- Didit V3 API surface unchanged. Existing webhook handlers, session-start payloads, and decision-fetch behaviour are byte-identical to v0.1.0.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/adapter-didit-v0.2.0
