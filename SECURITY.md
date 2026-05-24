# Security Policy

`canton-vc` is open-source infrastructure used by Canton Network
operators to issue and verify KYC / identity credentials. Security
issues affect real on-chain state. Please report them privately.

## Supported versions

| Version | Status |
|---|---|
| 0.x | Active — pre-1.0 reference releases. Security fixes land on the next minor (`0.x.y` → `0.(x+1).0`). |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues by emailing the maintainer privately:
**abdullahfarukozden@gmail.com**

Include:

- A description of the vulnerability.
- The layer affected (DAML contracts / TS SDK / KYC adapter / docs).
- Steps to reproduce.
- Potential impact (e.g. forged credential, replay, signature
  bypass, on-chain state corruption).
- Whether a fix is already drafted.

We aim for an initial acknowledgement within **48 hours** and a
remediation plan within **7 days**. Critical issues (forging
credentials, bypassing `DisclosedContract` authentication, signature
forgery) get a same-day response window.

## Coordinated disclosure

Fix lands first in a private security branch. We coordinate the
public disclosure date with the reporter so dependent issuers have a
window to upgrade before the vulnerability is public. The reporter
gets credit in the CHANGELOG (unless they prefer to remain
anonymous) and acknowledgement in the release notes.

## Hardening guarantees in canton-vc

- All cryptographic primitives use Node's standard `node:crypto`
  module (HMAC-SHA256, SHA-256, `timingSafeEqual`).
- Webhook signature verification enforces a 5-minute timestamp
  drift window by default.
- DAML templates enforce field invariants at the chain level
  (`ensure` clauses on `Credential` + `KycNFT`), so a misconfigured
  issuer cannot land a credential with empty `userRef`, out-of-range
  `humanScore`, or invalid `status` / `level` strings.
- The `Verify` choice on `Credential` is nonconsuming, so verifier
  participants cannot mutate or archive a credential.
- The `KycNFT` template is soulbound at the DAML level — no
  controller other than the operator can touch it.
- The verifier SDK (`@canton-vc/credential`) re-derives the
  `DisclosedContract.templateId` per-contract from the
  participant's ACS response, so a package upgrade on the issuer's
  side does not break verification of legacy credentials.

## Out of scope

- Vulnerabilities in third-party KYC vendors (Didit, Onfido, etc.).
  Report those directly to the vendor; we will track upstream fixes
  in our adapter packages.
- Issues in Canton, DAML, or the Splice protocol itself.
  Report those to the [Canton Foundation](https://canton.foundation).
- Brand-protection issues (typosquatting on npm, fake repositories).
  Not security vulnerabilities under this policy.
