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

- [`scripts/live-didit-canton-e2e-v2.ts`](../scripts/live-didit-canton-e2e-v2.ts) — Didit identity flow → 16-phase Canton lifecycle (mint × 4, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, `RevokeCredential` cascade, `UpdateCredentials`, `createKycNft`, `BurnNft`, wrong-admin reject)
- [`scripts/live-sumsub-canton-e2e-v2.ts`](../scripts/live-sumsub-canton-e2e-v2.ts) — same 16-phase shape against Sumsub's `testCompleted` sandbox
- [`scripts/live-persona-canton-e2e-v2.ts`](../scripts/live-persona-canton-e2e-v2.ts) — same 16-phase shape against Persona's sandbox inquiry API
- [`scripts/live-firm-test.ts`](../scripts/live-firm-test.ts) — two-firm verifier-side test

For the production reference deployment (Canton mainnet party id, on-chain DAR, ccview.io links), see the **Production reference**
subsection of `proposals/canton-vc-sdk.md` §Milestone 1.
