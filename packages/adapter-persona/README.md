# @canton-vc/adapter-persona

Production [`KycProvider`](../kyc-provider) implementation for the
[Persona](https://withpersona.com) KYC vendor.

## Install

```bash
pnpm add @canton-vc/adapter-persona @canton-vc/kyc-provider
```

## Usage

```ts
import { PersonaAdapter } from '@canton-vc/adapter-persona';

const kyc = new PersonaAdapter({
  apiKey: process.env.PERSONA_API_KEY!,            // Bearer token (`persona_…`)
  webhookSecret: process.env.PERSONA_WEBHOOK_SECRET!, // signs inbound webhooks
  identityTemplateId: process.env.PERSONA_IDENTITY_TEMPLATE_ID!, // `itmpl_…`
  // optional:
  addressTemplateId: process.env.PERSONA_ADDRESS_TEMPLATE_ID,
});

// 1. Start a session — redirect the user to session.redirectUrl (one-time link)
const session = await kyc.startSession({ userRef: 'user-123' });

// 2. Pull the decision after the user completes the inquiry
const decision = await kyc.fetchDecision(session.sessionId);
// decision.status === 'approved' | 'declined' | 'in_review' | 'pending' | 'expired'

// 3. Verify webhook (in your /webhook/persona handler)
const event = await kyc.verifyWebhook(rawBody, request.headers);
if (event === null) return new Response('invalid', { status: 400 });
// event.type === 'decision' | 'session.expired'
```

## Authentication — Bearer token

Persona uses a static Bearer token sent in the `Authorization` header
on every request. The adapter also pins `Persona-Version`, so a
Persona-side schema bump cannot silently change the request envelope
the adapter expects.

## Webhook signature — Persona-Signature

Persona signs webhooks with `t=<timestamp>,v1=<hex-hmac>` in the
`Persona-Signature` header. The HMAC is computed over
`<timestamp>.<rawBody>` with a SHA-256 digest. The adapter:

- Enforces a default 5-minute timestamp drift window (overridable).
- Tolerates **multiple active webhook secrets** so issuers can rotate
  secrets without a synchronous cutover — pass an array as
  `webhookSecret` and the adapter accepts a signature from any one of
  them in constant time.
- Compares signatures via `crypto.timingSafeEqual` to defeat timing
  side-channels.

## Inquiry model

Persona's identity model is **inquiry-centric** (one `inq_…` per KYC
attempt) rather than session-centric. The adapter normalises this
under `KycProvider.startSession` / `KycProvider.fetchDecision` so the
call site looks the same as the Didit and Sumsub adapters. The
underlying inquiry id surfaces as `KycSession.sessionId` — store it
as you would any opaque vendor handle.

## Hosted flow — one-time link

`startSession` creates an inquiry with `auto-create-one-time-link:
true`. Persona responds with a short URL (`withpersona.com/verify?code=…`)
that the issuer redirects the user to; the URL expires after one use.
This avoids hosting Persona's WebSDK on the issuer's domain.

## Decision level mapping

Persona's `verification`-typed inquiries produce a list of
sub-verifications (government ID, selfie, database, etc). The adapter
collapses these into the canton-vc `evidence` shape:

| canton-vc field      | Derived from |
|---|---|
| `identityVerified`  | Document + selfie verification both `passed` |
| `livenessVerified`  | Liveness sub-verification `passed` |
| `addressVerified`   | Proof-of-address verification `passed` |
| `level`             | `enhanced` when identity + address both pass; `basic` when identity alone passes |

## Configuration reference

| Field | Required | Default | Purpose |
|---|---|---|---|
| `apiKey` | ✅ | — | Persona API Bearer token. |
| `webhookSecret` | ✅ | — | Webhook signing secret (string or `readonly string[]` for key rotation). |
| `identityTemplateId` | ✅ | — | Persona inquiry template (`itmpl_…`) for identity. |
| `addressTemplateId` |   | — | Persona inquiry template for proof-of-address. |
| `baseUrl` |   | `https://api.withpersona.com` | API root. |
| `personaVersion` |   | `2023-01-05` | Pinned `Persona-Version` header. |
| `webhookDriftSeconds` |   | `300` | Allowed `Persona-Signature` `t=` drift. |
| `requestTimeoutMs` |   | `10000` | Per-request HTTP timeout. |
| `fetch` |   | `globalThis.fetch` | Override the fetch implementation. |
| `clock` |   | `Date.now` | Override the wall-clock source. |

## Implementing another vendor

The companion reference adapters
[`@canton-vc/adapter-didit`](../adapter-didit) (static API key,
sessions, canonical-JSON webhook HMAC) and
[`@canton-vc/adapter-sumsub`](../adapter-sumsub) (per-request HMAC,
applicants, multi-algorithm webhook digest) sit at the two other
corners of the KYC-vendor wire-shape design space. Persona is the
third structurally distinct shape (Bearer + JSON:API + inquiry +
signed-timestamp webhook). Pick whichever is closest to your target
and adapt from there. Open an issue with the vendor name to claim
the next adapter.

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
