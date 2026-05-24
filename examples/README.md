# Examples

Two runnable reference apps exercising the canton-vc SDK end-to-end
without a Canton participant or vendor credentials.

| Directory | Stack | What it shows | Run |
|---|---|---|---|
| [`issuer-demo/`](./issuer-demo) | Node 20+ CLI, TypeScript | The issuer pipeline: `startSession` → `fetchDecision` → `createCredential`. Mock vendor by default, or real Didit / Sumsub / Persona sandbox via `.env`. | `pnpm --filter @canton-vc/example-issuer-demo start` |
| [`verifier-demo/`](./verifier-demo) | Vite 5 + React 18 SPA | The verifier surface: `verifyDisclosure()` end-to-end against an in-memory Canton mock, plus issue + `KycNFT` cascade-revoke panels. | `pnpm --filter @canton-vc/example-verifier-demo dev` |

Both demos are mock-only by default — zero credentials, zero
participant, 30-second `git clone && pnpm install` to running.

For a full **real-Canton** round-trip (real DAR, real participant,
real sequencer signature) see the [`scripts/`](../scripts/)
directory at the repo root:

- [`scripts/live-didit-canton-manual-e2e.ts`](../scripts/live-didit-canton-manual-e2e.ts) — Didit identity flow → mint → DisclosedContract verify
- [`scripts/live-sumsub-canton-e2e.ts`](../scripts/live-sumsub-canton-e2e.ts) — Sumsub applicant flow → mint → verify
- [`scripts/live-persona-canton-manual-e2e.ts`](../scripts/live-persona-canton-manual-e2e.ts) — Persona inquiry flow → mint → verify → `KycNFT` cascade-revoke
- [`scripts/live-persona-canton-mint-existing.ts`](../scripts/live-persona-canton-mint-existing.ts) — re-mint an existing approved Persona inquiry
- [`scripts/live-canton-e2e.ts`](../scripts/live-canton-e2e.ts) — vendor-free on-chain leg
- [`scripts/live-firm-test.ts`](../scripts/live-firm-test.ts) — two-firm verifier-side test

For the production reference deployment (Canton mainnet party id, on-chain DAR, ccview.io links), see the **Production reference**
subsection of `proposals/canton-vc-sdk.md` §Milestone 1.
