# Governance

`canton-vc` is open-source ecosystem infrastructure for the Canton
Network. This document captures how decisions are made and how
maintainership scales beyond a single author.

## Current maintainership

| Role | Person |
|---|---|
| Lead Maintainer | [@Farukest](https://github.com/Farukest) (Abdullah Faruk Özden) |

The lead maintainer has commit rights on all packages, signs npm
releases, and is the single point of contact for security reports
(see [SECURITY.md](SECURITY.md)).

As the project matures, additional maintainers will be added under
a documented onboarding path. The first new maintainers are most
likely to come from organisations that ship adapter packages
(`@canton-vc/adapter-onfido`, `@canton-vc/adapter-persona`, …) and
demonstrate sustained quality contributions over multiple releases.

## Decision categories

### 1. CIP #204 standard surface

The `Cip204.Standard.Credential` interface surface (view shape +
the two standard choices `Credential_PublicFetch` and
`Credential_ArchiveAsHolder`) is governed by [CIP #204](https://github.com/canton-foundation/cips/pull/204)
at the Canton Foundation. This repository tracks the upstream
standard verbatim. Proposed changes to the standard surface:

1. Open the discussion upstream against `canton-foundation/cips`
   (PR comments on #204, or a follow-on CIP).
2. After the upstream change is accepted and tagged, roll the
   matching DAR + SDK changes in this repository referencing the
   upstream commit.

### 2. Implementer extensions

Implementer extensions in this repository — `RevokeCredential`,
`UpdateCredentials`, the `KycNFT` companion + `BurnNft`, and any
keys in the issuer's reverse-DNS claim namespace — are governed
locally. Changes:

1. Open a PR in this repository describing the new choice / claim
   key and its semantics.
2. For claim-key additions: include the matching proof-schema
   spec under `docs/proof-schemas/` (content-addressed) in the
   same PR.
3. Community review at the repository level (minimum 7 days for
   non-trivial changes).

Breaking changes to either the standard surface or the implementer
extensions require a major version bump on `canton-vc-credential`
(DAML) and `@canton-vc/core` + `@canton-vc/credential` (TS).
Legacy contracts under the prior DAR version remain queryable for
audit lookup against their original package id; new mints land on
the new DAR.

### 3. Adapter packages

Adapter packages (`@canton-vc/adapter-<vendor>`) implement the
`KycProvider` interface for a specific KYC vendor. They are
maintainer-light by design:

- Each adapter has a designated reviewer (the original
  contributor) who has merge rights on PRs scoped to that adapter.
- Adapter PRs that touch only their own `packages/adapter-<vendor>/`
  directory can be merged by the adapter reviewer.
- Adapter PRs that change `@canton-vc/kyc-provider` need
  lead-maintainer review (because the interface affects all
  adapters).

### 4. Routine code changes

Bug fixes, documentation improvements, dependency bumps:

- Pull request against `main`.
- At least one maintainer review.
- CI green (typecheck + lint + test + DAR build).
- Squash-merge into `main`. No long-lived feature branches.

## Funding and grants

The Canton Foundation development fund grant funding this project's
milestones is held and administered by the lead maintainer. All
milestone deliverables land in this public repository.

Future grant cycles or organisational funding sources will be
disclosed in the CHANGELOG with a link to the proposal that funded
the work.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Enforcement is the
lead maintainer's responsibility today; the bar moves to a small
panel of maintainers once we have at least three external
maintainers.
