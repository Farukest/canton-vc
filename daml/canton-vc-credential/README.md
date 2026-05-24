# canton-vc-credential (DAML package)

The canonical DAML side of the Canton Verifiable Credentials Standard
draft (see [`../../docs/cip-draft-canton-vc-standard.md`](../../docs/cip-draft-canton-vc-standard.md)).

## Modules

- **`Canton.VC.Credential`** — `Credential` template + `CredentialView`
  data + `KycNFT` companion. The wire shape and choice signatures
  conform to the CIP draft; any issuer that wants their on-chain
  credentials to be canton-vc-compatible deploys this package on
  their participant.

## Pre-built DAR

A pre-built DAR is committed at `release/canton-vc-credential-1.1.0.dar`
so the package can be uploaded to a participant without a local DAML
toolchain. Upload it with:

```bash
daml ledger upload-dar release/canton-vc-credential-1.1.0.dar
```

Then allocate an `Operator` party before minting credentials.

## Building from source

```bash
./build.sh        # native build (Linux / macOS / Windows with DAML SDK installed)
./build-wsl.sh    # Windows + WSL — builds in /tmp for filesystem performance
```

Both scripts produce `release/canton-vc-credential-1.1.0.dar`,
overwriting the committed copy. The intermediate `.daml/dist/` build
artifact is gitignored.

## Templates at a glance

```
Credential
├── signatories: operator
├── observers:   user
├── fields:      operator, user, userRef, proofHash, status, level,
│                validUntil, network, humanScore, validator,
│                identityVerified, livenessVerified, addressVerified
├── nonconsuming Verify : CredentialView    (controller fetcher)
├── consuming    RevokeCredential           (controller operator)
└── consuming    MigrateValidator           (controller operator)

KycNFT (optional companion, Enhanced-level only)
├── signatories: operator
├── observers:   customer
├── fields:      operator, customer, boundCredentialId, issuedAt,
│                level, serialNumber, displayName, image
└── consuming    BurnNft                    (controller operator)
```

## Compatibility with legacy operators

If a participant already hosts an earlier package with structurally
equivalent templates (for example a predecessor module under a
different package id), that package stays in the participant store
and existing on-chain credentials continue to verify correctly via
the legacy `Verify` choice. New issuers — and existing operators'
new mints — use this canonical `canton-vc-credential` package.
Multiple DARs can coexist on the same participant.

## License

Apache 2.0 — see [LICENSE](../../../LICENSE).
