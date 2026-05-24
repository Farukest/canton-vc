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

### 1. Wire format / DAML template / OIDC claim names

Anything that affects on-chain semantics or cross-issuer
interoperability MUST go through the CIP process:

1. Open a PR against `docs/cip-draft-canton-vc-standard.md` with the
   proposed change.
2. Post the PR to the Canton Foundation `grants-discuss` channel
   for community comment (minimum 14 days).
3. Address feedback. Merge the CIP change only after community
   review concludes.
4. Roll the matching SDK / DAML implementation change in a
   subsequent PR, referencing the merged CIP section.

Breaking changes to the canonical wire format require a major
version bump on `canton-vc-credential` (DAML) and `@canton-vc/core` +
`@canton-vc/credential` (TS). Legacy aliases stay supported for at
least one minor version after the canonical replacement lands.

### 2. Adapter packages

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

### 3. Routine code changes

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
