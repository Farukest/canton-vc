# verifier-demo — canton-vc SPA example

A browser-based runnable example that exercises the **verifier
surface** of the canton-vc SDK. Three interactive panels walk through
the full disclosure lifecycle: issue a credential, verify it via
`verifyDisclosure()`, and demonstrate `KycNFT` cascade-archive on
revoke — all against an in-memory Canton mock so the reviewer needs
no participant, no Docker, no credentials.

Built with React 18 + Vite 5 + TypeScript. The SPA calls the real
`@canton-vc/credential#verifyDisclosure()` function — the only thing
mocked is the `CantonClient` that the function calls into. Swap in a
real participant-pointed `CantonClient` and the same UI drives a real
on-chain verify.

## Quick start

```bash
# From the canton-vc repo root, after `pnpm install`:
pnpm --filter @canton-vc/example-verifier-demo dev
```

Open the printed URL (default `http://localhost:5173`). The page is
self-contained — no further setup.

## What each panel does

### 1. Issue credential

Click **Issue credential** to run the canonical issuer pipeline:

1. `provider.startSession({ workflow: 'identity' })` against the
   mock vendor.
2. `provider.fetchDecision(sessionId)` returns an approved decision
   (deterministic mock).
3. `canton.allocateParty()` + `canton.createCredential(input)` mints
   the credential to the in-memory mock and returns a `contractId` +
   blob.

The simulated-vendor dropdown at the top changes the on-chain
`validator` field (`DiditValidator` / `SumsubValidator` /
`PersonaValidator` / `Generic`), demonstrating the vendor-agnostic
SDK without depending on real vendor APIs from the browser.

### 2. Verify disclosure

Auto-populated from panel 1, or paste any `contractId` + base64 blob.
Clicking **Verify disclosure** calls the real
`verifyDisclosure(claims, { canton, fetcher })` from
`@canton-vc/credential`:

```ts
import { verifyDisclosure } from '@canton-vc/credential';

const view = await verifyDisclosure(
  { canton_vc_credential_blob: blob, canton_vc_contract_id: contractId },
  { canton, fetcher },
);
// view.isActive, view.userRef, view.level, view.validator, ...
```

The returned `CredentialView` is rendered with the full 12-field
struct and an active/inactive pill, matching what a firm's verifier
would consume off its own participant.

### 3. KycNFT cascade revoke

Mints an Enhanced-level credential and a soulbound `KycNFT`
companion. Click **Revoke (cascade-archive both)** to call
`canton.revokeCredential({ contractId, nftContractId })` — the Daml
choice body archives the credential and the NFT atomically in the
same transaction, demonstrating the cascade-burn behavior the
`Canton.VC.Credential.Revoke` choice enforces on chain.

## Mock vs real

| Layer | Default | Optional real mode |
|---|---|---|
| KYC vendor adapter (startSession / fetchDecision) | **Mock** — `BrowserMockProvider`, deterministic, in-browser. | **Real Didit / Sumsub / Persona sandbox API** via the Vite vendor-proxy plugin — see "Real vendor mode" below. |
| `CantonClient` (allocateParty / createCredential / verifyCredential / revokeCredential / createKycNft) | **Mock** — `MockCantonClient` in `src/lib/mock-canton.ts`. | Swap for a real `CantonClient` (`new CantonClient({ config })`) pointed at a participant for the on-chain leg. See `scripts/live-*-canton-*-e2e.ts` at the repo root for a fully-wired real-Canton flow. |
| `verifyDisclosure()` | **Always real** — the SPA uses the genuine `@canton-vc/credential` helper. The mock is only the `canton` argument passed to it. | — |

## Real vendor mode

Pick **Didit sandbox**, **Sumsub sandbox**, or **Persona sandbox**
from the header dropdown. The SPA then drives the real adapter
through the Vite dev-server proxy plugin (`vite-vendor-proxy-plugin.ts`):

```
SPA → POST /api/vendor/start-session  ─→  Vite plugin (Node side)
                                              · reads keys from .env (NEVER bundled)
                                              · instantiates real @canton-vc/adapter-{vendor}
                                              · calls adapter.startSession(...)
                                          ─→  vendor sandbox API
                                          ←─  KycSession JSON
SPA ← redirectUrl printed                 ←
[user opens redirectUrl, completes flow]
SPA → POST /api/vendor/fetch-decision  (every 5s)
                                          ─→  adapter.fetchDecision(sessionId)
                                          ─→  vendor sandbox API
SPA ← decision (poll until terminal)      ←
```

Server-side env names (NOT prefixed `VITE_`, so they stay out of the
browser bundle):

```bash
# .env (gitignored)
DIDIT_API_KEY=...
DIDIT_KYC_WORKFLOW_ID=...
DIDIT_WEBHOOK_SECRET=...

SUMSUB_APP_TOKEN=sbx:...
SUMSUB_SECRET_KEY=...
SUMSUB_LEVEL_NAME_IDENTITY=basic-kyc-level
SUMSUB_WEBHOOK_SECRET=...

PERSONA_API_KEY=persona_sandbox_...
PERSONA_TEMPLATE_ID=itmpl_...
PERSONA_WEBHOOK_SECRETS=...
```

Real vendor mode is **dev-server-only** — `pnpm dev` exposes the
proxy plugin; `pnpm build` produces a static SPA with no Node runtime
and no real-vendor support. That matches the demo's intent (boot
locally with your own sandbox keys; the bundle is never deployed).

## Why three different demo surfaces

`canton-vc` serves two integration personas — issuer and verifier —
and this repo exercises each through its natural surface:

| Persona | Demo | Why this shape |
|---|---|---|
| Issuer pipeline | [`examples/issuer-demo`](../issuer-demo) (Node CLI) | Real issuer pipelines run server-side as a worker; a CLI is the natural demo for a backend SDK call site |
| Verifier (the firm consuming credentials) | this SPA | Verification happens in firm-facing UX (OAuth-return flow, credential gate); a browser SPA shows the actual call site |
| Full on-chain leg (real Canton mint) | `scripts/live-*-canton-*-e2e.ts` | Requires a participant + DAR; standalone scripts let advanced reviewers go end-to-end without complicating the demos |

The shipped reference deployment ([Crivacy.io](https://crivacy.io))
already covers the real production round-trip from KYC vendor through
Canton mainnet — see the proposal's **Production reference** entry
under §M1 for the on-chain party id + ccview.io links.
