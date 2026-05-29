# canton-vc

> Open-source reference implementation for **verifiable credentials on the Canton Network**.
>
> Apache 2.0 · TypeScript-first · DAML-native · Canton 3.4

[![npm @canton-vc/core](https://img.shields.io/npm/v/@canton-vc/core?label=%40canton-vc%2Fcore&color=cb3837)](https://www.npmjs.com/package/@canton-vc/core)
[![npm @canton-vc/credential](https://img.shields.io/npm/v/@canton-vc/credential?label=%40canton-vc%2Fcredential&color=cb3837)](https://www.npmjs.com/package/@canton-vc/credential)
[![CI](https://img.shields.io/github/actions/workflow/status/Farukest/canton-vc/ci.yml?branch=main&label=CI)](https://github.com/Farukest/canton-vc/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CIP #204](https://img.shields.io/badge/CIP-%23204-blue)](https://github.com/canton-foundation/cips/pull/204)

`canton-vc` is the Canton-native pattern for issuing, holding, and
verifying KYC / identity credentials on the [Canton Network][canton].
It treats Canton's stakeholder model + `DisclosedContract`
authentication as the privacy primitive: no off-chain trust on the
issuer, no ZK overlay, no extra audit surface.

[canton]: https://canton.network

---

## What's in the box

| Package | Version | Purpose |
|---|---|---|
| [`@canton-vc/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@canton-vc/core?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/core) | Canton JSON Ledger v2 client — config, command builders for the full credential lifecycle (`createCredential`, `verifyCredential` / CIP #204 `Credential_PublicFetch`, `archiveAsHolder` / CIP #204 `Credential_ArchiveAsHolder`, `revokeCredential`, `updateCredentials`, `createKycNft`, `burnNft`), party parsing, Zod schemas, retry-aware fetch, content-addressed proof-schema infrastructure. No business logic. |
| [`@canton-vc/credential`](packages/credential) | [![npm](https://img.shields.io/npm/v/@canton-vc/credential?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/credential) | High-level OAuth 2.0 + OIDC client for issuer integration, plus `verifyDisclosure()` — the one-line cryptographically authenticated credential-verification helper for firms. |
| [`@canton-vc/kyc-provider`](packages/kyc-provider) | [![npm](https://img.shields.io/npm/v/@canton-vc/kyc-provider?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/kyc-provider) | Generic `KycProvider` interface decoupling the issuer from any specific KYC vendor. |
| [`@canton-vc/adapter-didit`](packages/adapter-didit) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-didit?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-didit) | Production adapter wrapping [Didit][didit] (v3 sessions API + HMAC-SHA256 webhooks). |
| [`@canton-vc/adapter-sumsub`](packages/adapter-sumsub) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-sumsub?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-sumsub) | Production adapter wrapping [Sumsub][sumsub] (applicants API + per-request HMAC signing + multi-algorithm webhook digest). |
| [`@canton-vc/adapter-persona`](packages/adapter-persona) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-persona?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-persona) | Production adapter wrapping [Persona][persona] (JSON:API inquiry endpoints + Bearer auth + signed-timestamp `Persona-Signature` webhooks with key rotation). |
| [`@canton-vc/adapter-mock`](packages/adapter-mock) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-mock?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-mock) | Deterministic adapter for tests and local dev — no network calls. |
| [`daml/canton-vc-credential`](daml/canton-vc-credential) | DAR v2.2.0 | DAML templates implementing the CIP #204 `Cip204.Standard.Credential` interface (`Credential_PublicFetch`, `Credential_ArchiveAsHolder`) plus implementer extensions (`RevokeCredential` with cascade burn, `UpdateCredentials` for bulk claims refresh) and the optional `KycNFT` companion. |

The Didit, Sumsub, and Persona adapters sit at three structurally distinct corners of the KYC-vendor design space: auth scheme (static API key vs per-request HMAC vs Bearer + version pin), identity model (sessions vs applicants vs inquiries), workflow vocabulary (workflow ids vs level names vs template ids), and webhook signature format (canonical-JSON HMAC vs multi-algorithm digest vs signed-timestamp HMAC with key rotation). All three fit behind the same `KycProvider` interface without changes to the issuer pipeline, so the interface is vendor-agnostic in practice, not just in design.

[didit]: https://didit.me
[sumsub]: https://sumsub.com
[persona]: https://withpersona.com

---

## Who uses canton-vc

Three classes of Canton participants integrate canton-vc, each at a different surface of the SDK:

**Identity-provider-style firms** integrate the issuer-side packages: `@canton-vc/core` for the Canton wire client, `@canton-vc/kyc-provider` plus one or more `@canton-vc/adapter-*` packages for KYC-vendor coverage, and the `Canton.VC.Credential` DAML templates from the canton-vc-credential DAR. These deployments mint credentials for their end users and expose the OAuth/OIDC userinfo endpoint that downstream verifiers point at. The grant proposal's §M1 **Production reference** entry documents the first production deployment running this pattern on Canton mainnet (on-chain party id + validator links).

**dApp / DeFi / NFT / lending verifiers** integrate the verifier-side primitives: the `verifyDisclosure()` helper from `@canton-vc/credential` and the OAuth client for fetching the disclosure blob from an issuer's userinfo endpoint. They accept credentials from any conforming canton-vc issuer with a single API call — no per-issuer integration code, no KYC partner contract on the verifier's side, and trustless verification anchored against the Canton sequencer's signature instead of the issuer's word.

**Regulated finance institutions** running their own KYC pipelines integrate the full stack on the issuer side, typically without exposing OAuth to public verifiers — credential issuance is internal and the on-chain audit replay via content-addressed proof schemas (`docs/proof-schemas/<id>.json`) is the compliance artifact. The multi-vendor adapter design lets compliance teams swap KYC vendors (Didit, Sumsub, Persona, or any future adapter implementing `KycProvider`) as a text-label change in the credential's `claims` map — no DAR upgrade, no enum extension, no re-implementation.

## Why use canton-vc

| You are... | Today, you... | With canton-vc, you... |
|---|---|---|
| **An identity provider** building on Canton | Write your own KYC-vendor adapter for each vendor, design your own DAML credential template, ship your own OAuth/OIDC claim schema, hand-roll the audit trail format | Use the standardized `KycProvider` interface (three production adapters shipped), mint into the canonical `Canton.VC.Credential` template, emit the CIP-spec OAuth claims, get audit-replay via content-addressed proof schemas |
| **A dApp adding KYC** to your users | Sign a KYC partner contract with Onfido / Sumsub / Persona, integrate their SDK into your front-end, host your own KYC pipeline, pay per verification | Accept any canton-vc issuer's credential via a single `verifyDisclosure()` call. The verifier does not operate KYC infrastructure or hold a KYC partner contract. The user's PII never crosses the verifier's wire |
| **A regulated institution** running internal KYC | Build your own audit trail on top of vendor receipts; swapping vendors means swapping the integration; the chain of custody from vendor decision to credential is verbal | Audit replay is a content-addressed schema document — a regulator can recompute the on-chain hash from your retained raw bytes. Vendor swap is a text-label change in the credential's `claims` map (no DAR upgrade). Both old and new vendor credentials remain queryable forever (Canton is append-only) |

---

## Prerequisites

- **Node.js 20+** for the TypeScript SDK and the runnable examples under [`examples/`](./examples).
- **A Canton 3.4 participant** with the `canton-vc-credential` DAR uploaded — required for any real on-chain mint or verify. Not needed for the mock paths described under [Try it](#try-it) below.
- **A KYC vendor sandbox account** (Didit, Sumsub, or Persona) — optional, only needed to drive the issuer pipeline against a real vendor.
- **DAML 3.4 SDK** — optional, only needed to rebuild the DAR yourself. The pre-built DAR ships at [`daml/canton-vc-credential/.daml/dist/canton-vc-credential-2.2.0.dar`](./daml/canton-vc-credential/.daml/dist/canton-vc-credential-2.2.0.dar) (mainnet package id `16fb51c2e9703cef173c76babd755afca9c7a01e34fc947aebc12205fdf0f719`).

---

## Quick start — verifier (firm consuming credentials)

```bash
npm install @canton-vc/core @canton-vc/credential
# or
yarn add @canton-vc/core @canton-vc/credential
# or
pnpm add @canton-vc/core @canton-vc/credential
```

```ts
import { CantonClient, getClaim, isWithinValidityWindow, loadCantonConfig } from '@canton-vc/core';
import { CantonVcClient, verifyDisclosure } from '@canton-vc/credential';

const issuer = new CantonVcClient({
  issuer: process.env.CANTON_VC_ISSUER_URL!,
  clientId: process.env.CANTON_VC_CLIENT_ID!,
  redirectUri: 'https://yourfirm.com/oauth/callback',
});

const canton = new CantonClient({ config: loadCantonConfig() });

// …complete the OAuth flow up to userinfo…
const claims = await issuer.userinfo(accessToken);

// `actor` is your firm's Canton party (the choice controller).
// `expectedAdmin` is the issuer's admin party (carried on the claims
// as `canton_vc_admin_party`). The CIP #204 implementer asserts
// `expectedAdmin == admin` inside `Credential_PublicFetch`, so a
// substituted credential is rejected at the chain boundary.
const view = await verifyDisclosure(claims, {
  canton,
  actor: 'YourFirm::1220abc…',
  expectedAdmin: claims.canton_vc_admin_party,
});

// Lifecycle interpretation is implementer-side per CIP #204.
if (!isWithinValidityWindow(view)) {
  throw new Error('Credential outside validity window');
}

// Subject-binding: read the user-ref claim from the issuer's
// reverse-DNS namespace (`com.example/*` below for illustration;
// each issuer picks their own per CIP #204 §"Namespacing").
const onChainUserRef = getClaim(view.claims, 'com.example/userRef');
if (onChainUserRef !== claims.sub) {
  throw new Error('Credential bound to a different user');
}

// Read application-specific fields from `view.claims.values`:
const level = getClaim(view.claims, 'com.example/level');                  // 'basic' | 'enhanced'
const identityVerified = getClaim(view.claims, 'com.example/identityVerified') === 'true';
const addressVerified = getClaim(view.claims, 'com.example/addressVerified') === 'true';
```

The blob authentication and the CIP #204 `Credential_PublicFetch`
interface choice execute on **your own Canton participant**. The
issuer cannot forge a credential or alter its claims after mint.
The OAuth claim set is a delivery hint; the truth is `view`.

---

## Quick start — issuer (running your own credential pipeline)

Pick the adapter that matches your KYC vendor. Three production
adapters ship in the repository today; the issuer code below is the
same regardless of which you import.

```bash
# With Didit
npm install @canton-vc/core @canton-vc/kyc-provider @canton-vc/adapter-didit
# (yarn add … / pnpm add … work identically)

# Or with Sumsub
npm install @canton-vc/core @canton-vc/kyc-provider @canton-vc/adapter-sumsub

# Or with Persona
npm install @canton-vc/core @canton-vc/kyc-provider @canton-vc/adapter-persona
```

```ts
import { CantonClient, createClaimSchema, loadCantonConfig } from '@canton-vc/core';
import { DiditAdapter } from '@canton-vc/adapter-didit';
// Or: import { SumsubAdapter } from '@canton-vc/adapter-sumsub';
// Or: import { PersonaAdapter } from '@canton-vc/adapter-persona';

const kyc = new DiditAdapter({
  apiKey: process.env.DIDIT_API_KEY!,
  webhookSecret: process.env.DIDIT_WEBHOOK_SECRET!,
  kycWorkflowId: process.env.DIDIT_KYC_WORKFLOW_ID!,
});

// Swap the constructor — the rest of the pipeline does not change:
//
//   const kyc = new SumsubAdapter({
//     appToken: process.env.SUMSUB_APP_TOKEN!,
//     secretKey: process.env.SUMSUB_SECRET_KEY!,
//     webhookSecret: process.env.SUMSUB_WEBHOOK_SECRET!,
//     identityLevelName: 'id-and-liveness',
//   });
//
//   const kyc = new PersonaAdapter({
//     apiKey: process.env.PERSONA_API_KEY!,
//     webhookSecret: process.env.PERSONA_WEBHOOK_SECRET!,
//     identityTemplateId: process.env.PERSONA_IDENTITY_TEMPLATE_ID!,
//   });

const canton = new CantonClient({ config: loadCantonConfig() });

// Pick your reverse-DNS claim namespace per CIP #204 §"Namespacing".
// The example below uses `com.example`; an implementer typically picks
// a namespace that reverses their own deployment's primary domain
// (e.g. `io.acme` for an issuer running at acme.io).
const CLAIM_KEYS = createClaimSchema('com.example', [
  'userRef','level','status','proofHash','proofSchemaId','validator',
  'humanScore','identityVerified','livenessVerified','addressVerified',
] as const);

// 1. Start a KYC session
const session = await kyc.startSession({ userRef: 'user-123' });
// → redirect user to session.redirectUrl

// 2. Webhook arrives → pull decision (vendor-agnostic shape)
const decision = await kyc.fetchDecision(session.sessionId);

// 3. Mint the on-chain credential — CIP #204 joint signatory
//    (`issuer + holder` co-sign at mint time so the holder cannot
//    be issued a credential without their participant's consent).
if (decision.status === 'approved') {
  const issuerParty = canton.config.operatorParty;
  const holderParty = await canton.allocateParty(`user_${decision.userRef}`);
  const validUntil = decision.expiresAt.replace(/\.\d+Z$/, 'Z'); // YYYY-MM-DDTHH:MM:SSZ
  const { contractId } = await canton.createCredential({
    issuerParty,
    holderParty,
    adminParty: issuerParty, // custodian model — issuer is the disclosure authority
    claims: {
      values: {
        [CLAIM_KEYS.userRef]: decision.userRef,
        [CLAIM_KEYS.level]: decision.level ?? 'basic',
        [CLAIM_KEYS.status]: 'active',
        [CLAIM_KEYS.proofHash]: decision.proofHash,
        [CLAIM_KEYS.proofSchemaId]: decision.proofSchemaId,
        [CLAIM_KEYS.validator]: 'didit', // free-form text label, swap as needed
        [CLAIM_KEYS.humanScore]: String(decision.evidence.humanScore ?? 0),
        [CLAIM_KEYS.identityVerified]: String(decision.evidence.identityVerified ?? false),
        [CLAIM_KEYS.livenessVerified]: String(decision.evidence.livenessVerified ?? false),
        [CLAIM_KEYS.addressVerified]: String(decision.evidence.addressVerified ?? false),
      },
      validFrom: new Date().toISOString(),
      validUntil,
      meta: {},
    },
    createdAt: new Date().toISOString(),
    expiresAt: validUntil,
    meta: {},
  });
}
```

Want to use a different KYC vendor (Onfido, Veriff, Au10tix,
Jumio, …)? Implement the `KycProvider` interface from
`@canton-vc/kyc-provider`. The three shipped adapters at
`packages/adapter-didit/src/adapter.ts`,
`packages/adapter-sumsub/src/adapter.ts`, and
`packages/adapter-persona/src/adapter.ts` are reference
implementations covering the three most common wire shapes.

---

## Try it

Two runnable examples under [`examples/`](./examples):

- **[`examples/issuer-demo`](./examples/issuer-demo)** — Node CLI exercising the issuer pipeline (`startSession` → `fetchDecision` → `createCredential`) against the mock vendor by default, or any of Didit / Sumsub / Persona sandbox via `.env`. In-memory Canton mock; no participant needed.

  ```bash
  pnpm --filter @canton-vc/example-issuer-demo start
  ```

- **[`examples/verifier-demo`](./examples/verifier-demo)** — Vite + React SPA exercising `verifyDisclosure()` end-to-end with three panels (issue, verify, `KycNFT` cascade-revoke). Mock-only by default; optional real-vendor proxy mode via `.env`.

  ```bash
  pnpm --filter @canton-vc/example-verifier-demo dev
  ```

For a full real-Canton round-trip (real participant, real DAR, real sequencer signature), live scripts under [`scripts/`](./scripts) drive the chain end-to-end. Canonical entry points: [`scripts/live-didit-canton-e2e-v2.ts`](./scripts/live-didit-canton-e2e-v2.ts), [`live-sumsub-canton-e2e-v2.ts`](./scripts/live-sumsub-canton-e2e-v2.ts), and [`live-persona-canton-e2e-v2.ts`](./scripts/live-persona-canton-e2e-v2.ts) — each runs the same 16-phase shape (mint × 4, all CIP #204 + implementer-extension choices, wrong-admin reject) against the corresponding vendor's sandbox + a Canton 3.4 participant.

---

## Architecture

`canton-vc` builds on Canton's stakeholder model. A `Canton.VC.Credential` contract has **joint signatories** — the **issuer** and the **holder** — per the CIP #204 mandate that the holder co-signs at mint time so an issuer cannot unilaterally mint without consent. An **admin** party is the disclosure authority that verifiers declare as `expectedAdmin` when exercising the public-fetch choice. In the custodian model the admin equals the issuer; in delegated-issuance setups they may differ.

Third-party verification uses the `DisclosedContract` primitive: the issuer ships the contract's `createdEventBlob` (and the contract id) to the verifying firm, typically as the `canton_vc_credential_blob` + `canton_vc_contract_id` claims on the OAuth userinfo response. The verifier's own participant re-derives the contract id from the blob and checks the sequencer signature; a tampered or fabricated blob is rejected with `DISCLOSED_CONTRACT_AUTHENTICATION_FAILED` before the choice body runs.

The `Credential_PublicFetch` interface choice (CIP #204 standard, nonconsuming) returns a `CredentialView` struct computed server-side from on-chain state. The implementer asserts `expectedAdmin == admin` inside the choice body so substituted credentials abort at the chain boundary, not silently. Lifecycle interpretation (`active` vs `expired` vs `revoked`) is implementer-side per CIP #204 — verifiers compare `claims.validUntil` against the current time and consult their own status policy. `@canton-vc/core` ships `isWithinValidityWindow()` as a helper for the common case.

Holders may voluntarily archive their own credential via the standard `Credential_ArchiveAsHolder` interface choice (CIP #204), which returns a structured result carrying the just-archived view plus caller-supplied metadata. Issuer-side compliance revoke is the implementer extension `RevokeCredential`, which cascade-archives an optional bound `KycNFT` companion in the same Canton transaction. The `UpdateCredentials` implementer extension supports issuer-side bulk claims refresh — archive the current contract and create a sibling carrying the new claims map without rotating the contract identity in spirit.

This makes canton-vc a Canton-native alternative to ZK selective-disclosure for the issuer-verifier-user triple — Canton's native privacy primitives (stakeholder model + sequencer-signed disclosure) carry the trust load without a ZK circuit toolchain or on-chain proof check.

---

## CIP #204 — Canton Verifiable Credentials Standard

`canton-vc` is the first production reference implementation of the [Canton Verifiable Credentials Standard (CIP #204)](https://github.com/canton-foundation/cips/pull/204). The on-chain `Canton.VC.Credential` template implements the `Cip204.Standard.Credential` interface verbatim — the two standard choices (`Credential_PublicFetch`, `Credential_ArchiveAsHolder`) ship unmodified, and the storage shape matches the CIP #204 view type (`admin / issuer / holder / claims : TextMap Text / createdAt / expiresAt / meta`). Implementer extensions (`RevokeCredential`, `UpdateCredentials`, `KycNFT` + `BurnNft`) live on the template itself, outside the interface surface, so any third-party verifier consuming the CIP #204 standard choice continues to work regardless of what extensions a given issuer adds.

The SDK was built alongside CIP #204 through its review cycle and adopted the Pure standard surface as a single breaking step at DAR v2.0.0, with the bulk-update path shipping at v2.2.0 (`16fb51c2e9703cef173c76babd755afca9c7a01e34fc947aebc12205fdf0f719`). New issuers inherit a clean CIP #204 surface from day one; new community DAML implementations of the same interface interoperate at the chain boundary without touching this SDK.

The on-chain `proofSchemaId` value carried in the credential's `claims` map references content-addressed schema specs in [`docs/proof-schemas/`](docs/proof-schemas/); regulators and auditors can replay any credential's `proofHash` deterministically from the firm's retained raw bytes using only the published schema + `@canton-vc/core#canonicalJson`.

---

## Project layout

```
canton-vc/
├── packages/
│   ├── core/                       Canton wire client + proof-schema (TS)
│   ├── credential/                 OAuth + verifyDisclosure (TS)
│   ├── kyc-provider/               KycProvider interface (TS)
│   ├── adapter-didit/              Didit production adapter (TS)
│   ├── adapter-sumsub/             Sumsub production adapter (TS)
│   ├── adapter-persona/            Persona production adapter (TS)
│   └── adapter-mock/               Test/dev mock adapter (TS)
├── daml/
│   └── canton-vc-credential/       DAML templates + DAR
├── docs/
│   ├── security-considerations.md  Threat model + adapter authoring rules
│   └── proof-schemas/              Content-addressed schema registry
├── scripts/                        Live end-to-end smoke scripts (mainnet) — every DAML choice exercised per vendor
├── examples/
│   ├── issuer-demo/                Runnable Node CLI (mock + 3 vendor sandboxes)
│   └── verifier-demo/              Runnable Vite + React SPA (verifier surface)
└── .github/workflows/              CI: typecheck + test + DAR build
```

---

## Contributing

We welcome contributions. The repository is permissive
(Apache 2.0). See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop,
and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

Adapters for additional KYC vendors (Onfido, Veriff, Au10tix, Jumio,
Trulioo, …) are the most-requested contribution — open an issue with
the vendor name to claim it. Didit, Sumsub, and Persona already ship
in this repository, covering the three most common wire shapes; use
any of them as a reference for the `KycProvider` shape.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Abdullah Faruk Özden ([@Farukest](https://github.com/Farukest))
and contributors.
