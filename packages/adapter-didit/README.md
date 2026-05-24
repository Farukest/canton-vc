# @canton-vc/adapter-didit

Reference [`KycProvider`](../kyc-provider) implementation for the
[Didit](https://didit.me) KYC vendor.

## Install

```bash
pnpm add @canton-vc/adapter-didit @canton-vc/kyc-provider
```

## Usage

```ts
import { DiditAdapter } from '@canton-vc/adapter-didit';

const kyc = new DiditAdapter({
  apiKey: process.env.DIDIT_API_KEY!,
  webhookSecret: process.env.DIDIT_WEBHOOK_SECRET!,
  kycWorkflowId: process.env.DIDIT_KYC_WORKFLOW_ID!,
  // optional:
  addressWorkflowId: process.env.DIDIT_ADDRESS_WORKFLOW_ID,
  callbackUrl: 'https://your-issuer.com/kyc/callback',
});

// 1. Start a session — redirect the user to session.redirectUrl
const session = await kyc.startSession({ userRef: 'user-123' });

// 2. Pull the decision after callback (or webhook fallback)
const decision = await kyc.fetchDecision(session.sessionId);
// decision.status === 'approved' | 'declined' | 'in_review' | 'pending' | 'expired'

// 3. Verify webhook (in your /webhook/didit handler)
const event = await kyc.verifyWebhook(rawBody, request.headers);
if (event === null) return new Response('invalid', { status: 400 });
// event.type === 'decision' | 'session.expired'
```

## Webhook signature

Didit signs every webhook with HMAC-SHA256 over the canonical JSON of
the body, sent in the `X-Signature-V2` header. The adapter enforces
the signature + a 5-minute drift window on `X-Timestamp`. Override
the drift window via `webhookDriftSeconds` if your operator policy
differs.

## Configuration reference

| Field | Required | Default | Purpose |
|---|---|---|---|
| `apiKey` | ✅ | — | Didit API key. |
| `webhookSecret` | ✅ | — | Signing secret for webhook HMACs. |
| `kycWorkflowId` | ✅ | — | Workflow id for identity verification. |
| `addressWorkflowId` |   | — | Workflow id for proof-of-address sessions. |
| `callbackUrl` |   | — | URL Didit redirects the user back to. |
| `baseUrl` |   | `https://verification.didit.me` | API root (override for sandbox). |
| `webhookDriftSeconds` |   | `300` | Max allowed `X-Timestamp` drift. |
| `requestTimeoutMs` |   | `10000` | Per-request HTTP timeout. |
| `fetch` |   | `globalThis.fetch` | Override the fetch implementation. |
| `clock` |   | `Date.now` | Override the wall-clock source. |

## Implementing another vendor

Look at this adapter, [`@canton-vc/adapter-sumsub`](../adapter-sumsub),
and the `KycProvider` interface in
[`@canton-vc/kyc-provider`](../kyc-provider/src/index.ts). The two
reference adapters cover the two common authentication patterns
most KYC vendors use: token-auth with canonical-JSON HMAC (Didit),
and per-request HMAC with raw-body digest (Sumsub). Pick whichever
matches your target vendor and adapt from there. Open an issue with
the vendor name to claim the next adapter.

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
