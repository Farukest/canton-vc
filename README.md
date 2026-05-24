# canton-vc

> Open-source reference implementation for **verifiable credentials on the Canton Network**.
>
> Apache 2.0 · TypeScript-first · DAML-native · Canton 3.4

[![npm @canton-vc/core](https://img.shields.io/npm/v/@canton-vc/core?label=%40canton-vc%2Fcore&color=cb3837)](https://www.npmjs.com/package/@canton-vc/core)
[![npm @canton-vc/credential](https://img.shields.io/npm/v/@canton-vc/credential?label=%40canton-vc%2Fcredential&color=cb3837)](https://www.npmjs.com/package/@canton-vc/credential)
[![CI](https://img.shields.io/github/actions/workflow/status/Farukest/canton-vc/ci.yml?branch=main&label=CI)](https://github.com/Farukest/canton-vc/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CIP draft](https://img.shields.io/badge/CIP-draft-orange)](docs/cip-draft-canton-vc-standard.md)

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
| [`@canton-vc/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@canton-vc/core?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/core) | Canton JSON Ledger v2 client — config, command builders (mint / verify / revoke), party parsing, Zod schemas, retry-aware fetch, content-addressed proof-schema infrastructure. No business logic. |
| [`@canton-vc/credential`](packages/credential) | [![npm](https://img.shields.io/npm/v/@canton-vc/credential?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/credential) | High-level OAuth 2.0 + OIDC client for issuer integration, plus `verifyDisclosure()` — the one-line trustless verification helper for firms. |
| [`@canton-vc/kyc-provider`](packages/kyc-provider) | [![npm](https://img.shields.io/npm/v/@canton-vc/kyc-provider?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/kyc-provider) | Generic `KycProvider` interface decoupling the issuer from any specific KYC vendor. |
| [`@canton-vc/adapter-didit`](packages/adapter-didit) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-didit?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-didit) | Production adapter wrapping [Didit][didit] (v3 sessions API + HMAC-SHA256 webhooks). |
| [`@canton-vc/adapter-sumsub`](packages/adapter-sumsub) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-sumsub?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-sumsub) | Production adapter wrapping [Sumsub][sumsub] (applicants API + per-request HMAC signing + multi-algorithm webhook digest). |
| [`@canton-vc/adapter-persona`](packages/adapter-persona) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-persona?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-persona) | Production adapter wrapping [Persona][persona] (JSON:API inquiry endpoints + Bearer auth + signed-timestamp `Persona-Signature` webhooks with key rotation). |
| [`@canton-vc/adapter-mock`](packages/adapter-mock) | [![npm](https://img.shields.io/npm/v/@canton-vc/adapter-mock?color=cb3837&label=)](https://www.npmjs.com/package/@canton-vc/adapter-mock) | Deterministic adapter for tests and local dev — no network calls. |
| [`daml/canton-vc-credential`](daml/canton-vc-credential) | DAR v1.1.0 | DAML templates (`Canton.VC.Credential` + `Canton.VC.KycNFT`) with cascade-archive on revoke. |

The Didit, Sumsub, and Persona adapters sit at three structurally distinct corners of the KYC-vendor design space: auth scheme (static API key vs per-request HMAC vs Bearer + version pin), identity model (sessions vs applicants vs inquiries), workflow vocabulary (workflow ids vs level names vs template ids), and webhook signature format (canonical-JSON HMAC vs multi-algorithm digest vs signed-timestamp HMAC with key rotation). All three fit behind the same `KycProvider` interface without changes to the issuer pipeline, so the interface is vendor-agnostic in practice, not just in design.

[didit]: https://didit.me
[sumsub]: https://sumsub.com
[persona]: https://withpersona.com

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
import { CantonClient, loadCantonConfig } from '@canton-vc/core';
import { CantonVcClient, verifyDisclosure } from '@canton-vc/credential';

const issuer = new CantonVcClient({
  issuer: process.env.CANTON_VC_ISSUER_URL!,
  clientId: process.env.CANTON_VC_CLIENT_ID!,
  redirectUri: 'https://yourfirm.com/oauth/callback',
});

const canton = new CantonClient({ config: loadCantonConfig() });

// …complete the OAuth flow up to userinfo…
const claims = await issuer.userinfo(accessToken);

const view = await verifyDisclosure(claims, {
  canton,
  fetcher: 'YourFirm::1220abc…',
});

if (!view.isActive) throw new Error('Credential not active on chain');
if (view.userRef !== claims.sub) throw new Error('Credential bound to a different user');
// view.level / view.identityVerified / view.addressVerified / … are now usable
```

The blob authentication and `Verify` choice execute on **your own
Canton participant**. The issuer cannot forge a credential or alter
its claims after mint. The OAuth claim set is a delivery hint; the
truth is `view`.

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
import { CantonClient, loadCantonConfig } from '@canton-vc/core';
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

// 1. Start a KYC session
const session = await kyc.startSession({ userRef: 'user-123' });
// → redirect user to session.redirectUrl

// 2. Webhook arrives → pull decision (vendor-agnostic shape)
const decision = await kyc.fetchDecision(session.sessionId);

// 3. Mint the on-chain credential
if (decision.status === 'approved') {
  const { contractId } = await canton.createKycCredential({
    userRef: decision.userRef,
    proofHash: decision.proofHash,
    proofSchemaId: decision.proofSchemaId,
    level: decision.level,
    validUntil: decision.expiresAt,
    network: canton.config.networkLabel,
    humanScore: decision.evidence.humanScore,
    validator: kyc.vendorName, // 'Didit' | 'Sumsub' | 'Persona' — stamped onto the credential
    identityVerified: decision.evidence.identityVerified ?? false,
    livenessVerified: decision.evidence.livenessVerified ?? false,
    addressVerified: decision.evidence.addressVerified ?? false,
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

## CIP draft — Canton Verifiable Credentials Standard

The wire format, scopes, claim names, and DAML template shapes in
`canton-vc` are drafted as a CIP — see
[`docs/cip-draft-canton-vc-standard.md`](docs/cip-draft-canton-vc-standard.md).
The intent is for this repository to be the reference implementation
of the CIP, with the standard formally proposed to the Canton
Foundation once the implementation has burnt-in for a release cycle.

The on-chain `proofSchemaId` field references content-addressed
schema specs in [`docs/proof-schemas/`](docs/proof-schemas/);
regulators and auditors can replay any credential's `proofHash`
deterministically from the firm's retained raw bytes using only the
published schema + `@canton-vc/core#canonicalJson`.

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
│   ├── cip-draft-canton-vc-standard.md
│   └── proof-schemas/              Content-addressed schema registry
├── scripts/                        Live end-to-end scripts against DevNet
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
