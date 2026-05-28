# @canton-vc/core

Canton V2 JSON Ledger client. This is the single source of truth for the Canton wire layer used by:

- **Issuer backend** (e.g. the reference operator's `apps/web`) — mints, revokes, queries KYC credentials.
- **`@canton-vc/credential`** — exposes `verifyDisclosure()` so consuming firms can verify a credential against **their own** Canton participant without depending on the issuer's infrastructure.

## What lives here

Pure Canton protocol code: no database, no application state, no Drizzle / Postgres / Next.js. Strictly the bytes that go over the wire to a Canton participant's JSON API plus the helpers to parse them back.

| Layer | Module | Purpose |
|-------|--------|---------|
| `errors` | single `CantonError` class + code union | typed failure surface |
| `config` | `loadCantonConfig` + zod schema | env-backed client config |
| `types` | branded ids + CIP #204 data shapes + claim accessors | type safety across the boundary |
| `schemas` | zod schemas for V2 API responses | wire validation |
| `party` | party-id parsing + namespace cache | identity layer |
| `http` | fetch wrapper with timeout + retry | transport |
| `commands` | pure builders for V2 command bodies | request shaping |
| `ledger` | high-level write ops (create / verify / archive-as-holder / revoke / NFT mint+burn) | full credential lifecycle |
| `query` | read ops (ACS + disclosure blob extraction) | post-mint inspection |
| `client` | facade class + process singleton | one-stop entry point |

## SDK surface (CIP #204 + implementer extensions)

The `Canton.VC.Credential` template implements the `Cip204.Standard.Credential` interface (`viewtype CredentialView`). The SDK wraps every choice exposed by the deployed DAR:

| SDK method | DAML choice | Source |
|---|---|---|
| `createCredential()` | template create (joint signatory: issuer + holder) | implementer (implements CIP #204 via `interface instance`) |
| `verifyCredential()` | `Credential_PublicFetch` (nonconsuming interface choice) | **CIP #204** |
| `archiveAsHolder()` | `Credential_ArchiveAsHolder` (consuming interface choice) | **CIP #204** |
| `revokeCredential()` | `RevokeCredential` (template choice, cascade-burns bound NFT) | implementer (issuer compliance path) |
| `createKycNft()` / `burnNft()` | `KycNFT` template create + `BurnNft` choice | implementer (soulbound showcase companion) |

## Consumer-side verification

A third-party firm can verify a credential against **its own** Canton participant by exercising `Credential_PublicFetch` with the issuer-supplied `createdEventBlob` attached as a `DisclosedContract`. Canton authenticates the blob against the sequencer signature server-side; the choice body enforces `expectedAdmin == admin` so a substituted credential is rejected at the chain boundary.

`@canton-vc/credential`'s `verifyDisclosure(claims, { canton })` wraps this whole flow so firms write five lines of code, not Canton protocol bytes.

## Workspace consumption

`apps/web` and `@canton-vc/credential` both depend on this via pnpm workspace links (`"@canton-vc/core": "workspace:*"`). The package exports TypeScript source directly (`main: ./src/index.ts`) — no build step.
