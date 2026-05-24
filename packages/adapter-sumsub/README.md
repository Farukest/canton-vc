# @canton-vc/adapter-sumsub

Production [`KycProvider`](../kyc-provider) implementation for the
[Sumsub](https://sumsub.com) KYC vendor.

## Install

```bash
pnpm add @canton-vc/adapter-sumsub @canton-vc/kyc-provider
```

## Usage

```ts
import { SumsubAdapter } from '@canton-vc/adapter-sumsub';

const kyc = new SumsubAdapter({
  appToken: process.env.SUMSUB_APP_TOKEN!,     // 'sbx:…' (sandbox) or 'prd:…' (prod)
  secretKey: process.env.SUMSUB_SECRET_KEY!,   // signs every REST request
  webhookSecret: process.env.SUMSUB_WEBHOOK_SECRET!, // signs inbound webhooks
  identityLevelName: 'id-and-liveness',
  // optional:
  addressLevelName: 'enhanced-poa-level',
});

// 1. Start a session — redirect the user to session.redirectUrl
const session = await kyc.startSession({ userRef: 'user-123' });

// 2. Pull the decision after callback (or webhook fallback)
const decision = await kyc.fetchDecision(session.sessionId);
// decision.status === 'approved' | 'declined' | 'in_review' | 'pending' | 'expired'

// 3. Verify webhook (in your /webhook/sumsub handler)
const event = await kyc.verifyWebhook(rawBody, request.headers);
if (event === null) return new Response('invalid', { status: 400 });
// event.type === 'decision' | 'session.expired'
```

## Authentication — per-request HMAC

Unlike adapters that use a static API key, Sumsub signs **every**
REST request. The adapter computes
`HMAC-SHA256(secretKey, ts + method + path + body)` and sends it in
`X-App-Access-Sig`, alongside `X-App-Access-Ts` (Unix seconds) and
`X-App-Token` (your app token). The signing helper is exported as
`signSumsubRequest` for testing.

## Webhook signature

Sumsub signs webhooks with a separate, per-endpoint secret configured
in the Sumsub console. The digest is sent in `X-Payload-Digest`, with
`X-Payload-Digest-Alg` selecting the algorithm: `HMAC_SHA1_HEX`,
`HMAC_SHA256_HEX`, or `HMAC_SHA512_HEX`. The adapter verifies all
three in constant time.

## End-to-end testing

Sumsub publishes an officially supported development path: the
`testCompleted` endpoint short-circuits the applicant lifecycle to
approval so the issuer can exercise the full adapter surface
(`startSession` → `fetchDecision` → `verifyWebhook`) against the real
Sumsub API without requiring a human to upload documents on every
run. The repository's `scripts/live-sumsub-canton-e2e.ts` chains this
through to a real Canton 3.4 participant — adapter → mint → revoke
cascade are all exercised against live infrastructure end-to-end.

## Configuration reference

| Field | Required | Default | Purpose |
|---|---|---|---|
| `appToken` | ✅ | — | Sumsub app token (`sbx:` sandbox / `prd:` prod). |
| `secretKey` | ✅ | — | Per-request HMAC signing key. |
| `webhookSecret` | ✅ | — | Webhook digest verification key. |
| `identityLevelName` | ✅ | — | Sumsub level name for identity workflow. |
| `addressLevelName` |   | — | Sumsub level name for proof-of-address workflow. |
| `baseUrl` |   | `https://api.sumsub.com` | API root. |
| `requestTimeoutMs` |   | `10000` | Per-request HTTP timeout. |
| `websdkTtlSeconds` |   | `1800` | WebSDK link TTL passed to Sumsub. |
| `fetch` |   | `globalThis.fetch` | Override the fetch implementation. |
| `clock` |   | `Date.now` | Override the wall-clock source. |

## Implementing another vendor

The companion reference adapter
[`@canton-vc/adapter-didit`](../adapter-didit) uses a structurally
different wire shape (static API key + canonical-JSON webhook HMAC
+ session-id identity model + workflow-id vocabulary). Pick whichever
of the two is closer to your target vendor's authentication pattern
and adapt from there. Open an issue with the vendor name to claim
the next adapter.

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
