# Contributing to canton-vc

Thanks for your interest. `canton-vc` is open-source ecosystem
infrastructure — every contribution that improves the Canton-native
KYC / verifiable credentials story is welcome.

## What we're looking for

In priority order:

1. **KYC vendor adapter PRs** — `@canton-vc/adapter-onfido`,
   `-persona`, `-sumsub`, `-veriff`, `-au10tix`, `-jumio` … each
   one a fresh package implementing the `KycProvider` interface in
   `@canton-vc/kyc-provider`. Open an issue with the vendor name to
   claim the slot before starting work, so we don't duplicate.
2. **Multi-language ports** — `canton-vc` already targets
   TypeScript; Python is on the M2 roadmap. Go, Java, Rust, .NET
   ports are welcome but coordinate via an issue first.
3. **Documentation** — cookbook recipes, architecture notes,
   adapter integration walkthroughs.
4. **Bug reports + fixes against the reference implementation.**

## What we're NOT looking for (right now)

- Breaking changes to the `Cip204.Standard.Credential` interface
  surface — that surface is governed by [CIP #204](https://github.com/canton-foundation/cips/pull/204)
  upstream; this repository implements it verbatim and tracks
  upstream revisions rather than diverging.
- Issuer-specific UI / branding contributions — `canton-vc` is the
  vendor-neutral SDK layer.

## Dev loop

```bash
git clone https://github.com/canton-vc/canton-vc
cd canton-vc
pnpm install
pnpm typecheck
pnpm test
```

DAML rebuilds require [DAML SDK](https://docs.daml.com/getting-started/installation.html)
and Canton 3.4+. See `daml/canton-vc-credential/README.md`.

## PR checklist

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm lint` clean (biome)
- [ ] If DAML changed: DAR rebuilds on Canton 3.4 + 3.5 + 3.6
- [ ] If implementer-extension claim names changed (issuer's
      reverse-DNS namespace under the CIP #204 `claims` TextMap):
      update the relevant proof-schema spec under
      `docs/proof-schemas/` in the same PR
- [ ] No PII / secrets / vendor API keys in committed code or tests
      (use `.env.example` placeholders)

## Sign-off

We don't require DCO sign-off, but please write commit messages
in the conventional format (`feat:` / `fix:` / `docs:` / `chore:`)
and keep them descriptive.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be kind, be specific,
assume good faith.
