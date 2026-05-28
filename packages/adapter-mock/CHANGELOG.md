# Changelog

All notable changes to `@canton-vc/adapter-mock` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the 0.x caveat that minor bumps may carry breaking changes until 1.0.0.

## [0.2.0] — 2026-05-28

### Changed

- Depends on `@canton-vc/kyc-provider ^0.2.0`. The synthetic `KycDecision` shape produced by the mock adapter remains the `KycProvider` contract — used by tests, examples, and the `examples/issuer-demo` / `examples/verifier-demo` smoke harnesses.

### Notes

- Mock surface and synthetic decision payload unchanged. Existing test code that consumes `MockAdapter` works without modification.

[0.2.0]: https://github.com/Farukest/canton-vc/releases/tag/adapter-mock-v0.2.0
