# issuer-demo — canton-vc CLI example

A runnable command-line example that walks the **issuer pipeline**
end-to-end against the canton-vc SDK. Picks a `KycProvider`
implementation at runtime from `CANTON_VC_VENDOR`, calls
`startSession` + `fetchDecision` + `createCredential` in the same
order a production issuer worker would, and prints the resulting
contract data to stdout.

The on-chain leg uses an in-memory Canton mock — there is no real
participant and nothing is committed to a ledger. The point of this
demo is to show **the SDK call sites and the field flow**, not to
claim an on-chain mint occurred. For a real Canton participant
round-trip, see [`scripts/`](../../scripts/) at the repo root.

## Quick start

```bash
# From the canton-vc repo root, after `pnpm install`:
pnpm --filter @canton-vc/example-issuer-demo start
```

That's it — no credentials, no Canton participant, no Docker. The
demo runs the full pipeline with the deterministic
`@canton-vc/adapter-mock` provider and a fake in-memory Canton
client.

## Three try levels

| Level | What you set up | What runs | Real or mock? |
|---|---|---|---|
| **1. Mock** | `pnpm install` only | adapter-mock + mock canton | Both mock — deterministic fixture |
| **2. Real KYC vendor sandbox** | Copy `.env.example` → `.env`, set `CANTON_VC_VENDOR=didit\|sumsub\|persona`, paste your sandbox API key | Real vendor adapter (real HMAC, real webhook scheme, real session URL) + mock canton | Vendor real, canton mock |
| **3. Real Canton mint** | `scripts/live-*-canton-*-e2e.ts` at repo root (separate workflow) | Real vendor + real Canton participant + real DAR | Both real |

This demo covers levels 1 and 2. Level 3 is intentionally a separate
script (it needs a Canton participant + DAR upload, which is overkill
for a 30-second SDK tour).

## What the mock is and what it isn't

`@canton-vc/adapter-mock` is **not** a fake-response generator that
ships nonsense data. It returns deterministic `KycDecision` values
whose shape matches exactly what the real Didit / Sumsub / Persona
adapters return — the same `proofHash` + `proofSchemaId` + `evidence`
structure, just computed over a fixed seed instead of vendor data.
The four production adapters are exercised against this same mock
in our test suites (132 unit tests).

The mock skips two things real adapters do: HMAC request signing and
webhook signature verification. To exercise those code paths, switch
to level 2 with your own sandbox credentials.

## Vendor sandbox setup (level 2)

Each vendor offers a free sandbox tier. Sign up, get the keys, and
fill in the matching block in `.env`:

### Didit

```bash
CANTON_VC_VENDOR=didit
DIDIT_API_KEY=...
DIDIT_KYC_WORKFLOW_ID=...
DIDIT_WEBHOOK_SECRET=...
```

The demo will print a Didit session URL. Open it in a browser,
complete the document + selfie flow, return to the terminal — the
demo polls every 5 seconds and continues once Didit transitions to a
terminal decision.

### Sumsub

```bash
CANTON_VC_VENDOR=sumsub
SUMSUB_APP_TOKEN=sbx:...
SUMSUB_SECRET_KEY=...
SUMSUB_LEVEL_NAME_IDENTITY=basic-kyc-level
SUMSUB_WEBHOOK_SECRET=...
```

### Persona

```bash
CANTON_VC_VENDOR=persona
PERSONA_API_KEY=persona_sandbox_...
PERSONA_TEMPLATE_ID=itmpl_...
PERSONA_WEBHOOK_SECRETS=...
```

Persona returns a hosted one-time-link inquiry URL — open it, complete
the flow, return to the terminal.

## Output shape

Every step is printed so you can see the SDK call sites and the field
flow end-to-end:

```
canton-vc — issuer demo
  vendor:  mock (no credentials needed)
  backend: in-memory Canton mock

[12:34:56] Step 1: provider.startSession({ workflow: "identity" })
  sessionId:    mock_abc1234567890def
  redirectUrl:  https://mock.canton-vc.local/widget/mock_...
  expiresAt:    2026-05-24T13:34:56.000Z

[12:34:56] Step 2: provider.fetchDecision(sessionId)
  status:       approved
  level:        basic
  identity:     true
  liveness:     true
  address:      false
  proofHash:    7c4a8d09ca3762af61e59520943dc26494f8941b…
  schemaId:     6e3a6f0e1c4d5d8b9a0c2f1d8e7b6c5a4f3d2e1c…

[12:34:56] Step 3: canton.allocateParty() + canton.createCredential()
  contractId:   3f29c5b8e7d1a4f6c2e0b8d9a7c6e5d4f3b2a1c0…
  updateId:     mock-upd-abcd1234efgh5678ijkl90mnop12qr34st
  recordTime:   2026-05-24T12:34:56.000Z

[12:34:56] done — credential minted to in-memory mock
```

The values match what the real SDK call sites accept and produce —
swap the mock for a real Canton participant and the same flow drives
an on-chain mint without any code change.
