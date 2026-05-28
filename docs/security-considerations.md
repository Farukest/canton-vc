# Security Considerations

This document records the threat model `canton-vc` operates under, the boundary between what the SDK enforces versus what the issuer application must enforce, and the recommended patterns for the two operational risks that fall outside the SDK's enforcement reach.

This is a normative companion to [CIP #204](https://github.com/canton-foundation/cips/pull/204) — the CIP names the wire format and the on-chain constraints (`Cip204.Standard.Credential` interface, `Credential_PublicFetch`, `Credential_ArchiveAsHolder`, joint signatory model); this document names the operational responsibilities for any conforming implementation.

---

## 1. Vendor webhook trust

### 1.1. Threat

Every `canton-vc` issuer pipeline is anchored on a single trust edge: the issuer accepts the KYC vendor's webhook (HMAC-signed in all three shipped adapters) as proof that the user completed verification.

If the vendor's webhook signing secret is compromised — through a vendor-side breach, a leaked staging credential, or a developer mistake on the issuer's side — an attacker holding the secret can:

1. Open a fresh applicant against the vendor (no actual KYC takes place),
2. Forge a "GREEN / APPROVED" webhook signed with the leaked secret,
3. Have the issuer pipeline mint a credential on Canton against a user who never completed real verification.

The on-chain credential is real (signed by the issuer's party); the off-chain trust assumption that fed the mint was false. Because Canton is append-only, the bogus mint cannot be rewritten — only revoked. The exposure window between mint and revocation is the window in which downstream verifiers (DeFi protocols, lending platforms, regulated finance gates) may have already honoured the credential.

### 1.2. SDK scope

The SDK enforces the cryptographic verification of the webhook itself — `parseWebhook(payload, signature)` returns either a validated decision or raises a typed error. It does not enforce any policy on what the issuer pipeline does after that point. The SDK assumes that webhook signature verification + payload schema validation are necessary but not sufficient for a high-assurance issuer.

### 1.3. Recommended mitigation: dual-channel reconciliation

For any issuer pipeline where credential mints have material downstream value (DeFi access, lending eligibility, regulated finance compliance), webhook trust alone is insufficient. The recommended pattern is dual-channel verification: every webhook is cross-checked against an independent REST API call to the same vendor.

```ts
// On every webhook arrival:
const webhookDecision = adapter.parseWebhook(payload, signature);

// Always re-fetch from the vendor's REST API as a second channel.
const restDecision = await adapter.getDecision(webhookDecision.sessionId);

if (!decisionsAgree(webhookDecision, restDecision)) {
  // Drift detected — webhook says one thing, REST says another.
  // An attacker with the webhook secret but no REST API key cannot
  // make both channels lie consistently.
  await alertOps({ webhookDecision, restDecision });
  return; // do not mint
}

// Both channels agree → trust and proceed.
await mintCredential(restDecision);
```

This pattern requires the attacker to compromise **two** separate secrets (webhook HMAC key + REST API bearer/key) to mint a fraudulent credential. The two channels are operated by separate infrastructure inside the vendor and rotated independently in practice; compromising both simultaneously is materially harder than compromising either alone.

### 1.4. Recommended mitigation: periodic reconciliation worker

Webhook delivery is best-effort. Webhooks can be:

- **delayed** (vendor outage, network partition, retry backoff),
- **duplicated** (vendor retry after timeout, with identical payload),
- **dropped** (issuer outage during delivery window),
- **forged** (compromised secret).

A periodic reconciliation worker scans the issuer's local state for sessions that should have a terminal state by now and cross-checks the vendor's REST API:

```text
every N minutes (5 recommended):
  for each session where status is non-terminal AND
                       last_change > 30 minutes ago:
    restDecision = adapter.getDecision(session.id)
    if restDecision is terminal:
      if matches local state:
        mark reconciled
      if local says approved and REST says rejected:
        # reverse drift — possible webhook forgery, or human-review reversal
        revoke credential on chain
        alert ops
      if local says pending and REST says approved:
        # forward drift — webhook dropped
        mint credential
```

The window between webhook delivery and the next reconciliation pass bounds the maximum exploitable window for a forged-webhook attack. A 5-minute cadence bounds the attack window to under 10 minutes; tighter cadences are possible at the cost of additional vendor REST quota usage.

### 1.5. Reference implementation

The Crivacy.io production deployment runs the dual-channel verification + periodic reconciliation pattern against Canton mainnet. The exact worker is application-specific — it uses pg-boss for scheduling and PostgreSQL for state, which are choices outside the SDK's opinion — but the pattern itself is reproducible in any scheduler and storage layer. The `getDecision()` building block in `@canton-vc/kyc-provider` is the only SDK surface the worker needs to call.

---

## 2. Adapter authoring

### 2.1. Threat

The `KycProvider` interface in `@canton-vc/kyc-provider` is the extension point for KYC vendors beyond the three shipped adapters (Didit, Sumsub, Persona). A community contributor implementing a new adapter — for Onfido, Veriff, Au10tix, Jumio, or an in-house vendor — operates outside the maintainer-shipped audit surface.

A misconfigured adapter can fail open in several ways:

- **Skipped signature verification.** `parseWebhook()` accepts any payload without HMAC check; any HTTP client can post a payload that mints a credential.
- **Algorithm confusion.** HMAC-SHA256 verifier silently accepts HMAC-SHA1 or MD5, or the wrong hash input scope (body only vs. `ts + method + path + body`).
- **Replay vulnerability.** No nonce or timestamp window enforcement; an old, legitimately-signed webhook can be replayed by anyone who once captured it.
- **`proofHash` drift.** The adapter computes the on-chain proof hash from a different field set than the canonical `proof-hash` module in `@canton-vc/core` — the on-chain hash is then non-recomputable from the retained raw bytes, breaking audit replay.
- **Status enum lossy mapping.** Vendor-specific statuses are collapsed to a binary "approved / not approved" without surfacing the actual rejection reason, breaking the operator's ability to apply downstream policy (decline cooldown, manual-review queue, repeat-evader detection).

### 2.2. SDK scope

The `KycProvider` interface is structurally enforced by TypeScript: an adapter that does not implement `parseWebhook`, `getDecision`, `startSession` will not compile against the workspace. The SDK does *not* enforce that the implementation is correct — that is the adapter author's responsibility.

### 2.3. Recommended pattern: adapter test suite parity

Each shipped adapter in `@canton-vc/adapter-*` has a sibling test file at `tests/adapter.test.ts` covering the same categories:

- HMAC signature accept (positive) and reject (negative — truncated, wrong key, wrong algorithm) cases.
- Schema validation accept and reject cases for the full webhook payload shape.
- Timestamp drift window (where the vendor's signing scheme includes timestamps, e.g. Persona's `Persona-Signature` header).
- Status enum mapping for every documented vendor status — not only the happy-path "approved".
- Idempotency under duplicate webhook delivery.
- `proofHash` byte-identity against the canonical schema.

A new adapter is "production-ready" when it has parity coverage against this checklist. Adapter authors are strongly recommended to copy the test file from the shipped adapter closest in shape — Didit for body-HMAC, Sumsub for prefixed-HMAC, Persona for signed-timestamp HMAC — and adapt rather than write from scratch.

### 2.4. Recommended pattern: canonical `proofHash` dependency

Adapters MUST compute the proof hash via the canonical `computeProofHash()` export from `@canton-vc/core` — never by hand-rolling SHA-256 over a locally-defined field set. The canonical module pins the field order, the canonical JSON serialization, and the hash algorithm; it is the single source of truth for the byte sequence the on-chain hash is computed against. An adapter that reuses this module remains compatible with on-chain audit replay even if the proof schema version advances; one that re-implements it locally will silently drift.

### 2.5. Recommended pattern: stable `validator` label

The validator label is carried in the credential's CIP #204 `claims : TextMap Text` slot under the issuer's reverse-DNS namespace (the Crivacy reference deployment uses `io.crivacy/validator = 'DiditValidator'`). New adapters SHOULD pick a stable, documented label that downstream verifiers can switch on; the on-chain template does not enforce a closed enum, so adding a new vendor is a label change rather than a DAR upgrade. Issuers SHOULD publish their namespace + accepted labels alongside the OAuth scope catalogue so verifiers know which strings to expect.

---

## 3. PII boundary

No PII reaches the chain. Every value carried in the CIP #204 `claims : TextMap Text` field under the issuer's reverse-DNS namespace is either a non-PII identifier (`userRef`, a credential-scoped random pseudonym in conformant deployments; the `userRefLooksLikePseudonym()` helper in `@canton-vc/credential` provides an opt-in verifier-side check), an enum rendered as text, a boolean rendered as text, a network label, or a one-way SHA-256 digest (`proofHash`). PII enters the hash input only and is non-recoverable from the on-chain digest.

The full canonical-JSON specification driving `proofHash` lives under [`docs/proof-schemas/`](./proof-schemas/) — content-addressed by the `proofSchemaId` claim. An auditor with the firm's retained raw bytes plus the published schema can recompute the on-chain digest deterministically; the hash never depends on undocumented vendor-specific shape.

---

## 4. Scope summary

| Concern | SDK enforces | Operator must enforce |
|---|---|---|
| Webhook HMAC verification | ✅ via `parseWebhook()` | — |
| Webhook payload schema | ✅ via Zod in adapter | — |
| Dual-channel reconciliation | — | ✅ §1.3 pattern |
| Periodic reconciliation worker | — | ✅ §1.4 pattern |
| Adapter signature correctness | — | ✅ §2.3 test parity |
| Canonical `proofHash` computation | ✅ via `@canton-vc/core` | ✅ via §2.4 dependency rule |
| `validator` enum value | ✅ at DAML `ensure` boundary | ✅ via §2.5 |
| `userRef` pseudonymity | — (heuristic only via §3 helper) | ✅ issuer policy choice |
| PII on-chain | ✅ at the schema boundary | — |
