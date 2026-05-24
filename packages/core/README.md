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
| `types` | branded ids + DAML/DB enum mappings | type safety across the boundary |
| `schemas` | zod schemas for V2 API responses | wire validation |
| `party` | party-id parsing + namespace cache | identity layer |
| `http` | fetch wrapper with timeout + retry | transport |
| `commands` | pure builders for V2 command bodies | request shaping |
| `ledger` | high-level write ops (create / verify / revoke) | mint pipeline |
| `query` | read ops (ACS + disclosure blob extraction) | post-mint inspection |
| `client` | facade class + process singleton | one-stop entry point |

## Consumer-side verification

The flexible-controller `Verify` choice on `KYCCredential` lets a third-party firm verify a credential against its own participant — no issuer participant access required. The credential's `createdEventBlob` (base64url) is shipped to firms via OAuth userinfo as `canton_vc_credential_blob`; the firm attaches it as a `DisclosedContract` on the exercise command, Canton authenticates the blob server-side, and the choice returns the full `CredentialView` struct.

`@canton-vc/credential`'s `verifyDisclosure(claims, { canton })` wraps this whole flow so firms write five lines of code, not Canton protocol bytes.

## Workspace consumption

`apps/web` and `@canton-vc/credential` both depend on this via pnpm workspace links (`"@canton-vc/core": "workspace:*"`). The package exports TypeScript source directly (`main: ./src/index.ts`) — no build step.
