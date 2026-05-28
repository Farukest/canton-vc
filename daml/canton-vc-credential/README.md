# canton-vc-credential (DAML package)

The DAML side of `canton-vc` — implements the
[Canton Verifiable Credentials Standard (CIP #204)](https://github.com/canton-foundation/cips/pull/204)
verbatim, plus three implementer extensions (`RevokeCredential`,
`UpdateCredentials`, `KycNFT` companion + `BurnNft`).

## Modules

- **`Canton.VC.Credential`** — `Credential` template implementing
  the `Cip204.Standard.Credential` interface + `KycNFT` companion.
  The view shape, signatory model, and standard choices
  (`Credential_PublicFetch`, `Credential_ArchiveAsHolder`) conform
  to CIP #204; any issuer deploying this package is automatically
  compatible with verifiers built against the standard interface.

## Pre-built DAR

A pre-built DAR is committed at `release/canton-vc-credential-2.1.0.dar`
so the package can be uploaded to a participant without a local DAML
toolchain. Upload it with:

```bash
daml ledger upload-dar release/canton-vc-credential-2.1.0.dar
```

Then allocate an `Operator` (issuer) party before minting credentials.
Mainnet package id of v2.1.0: `562bbc757d5ec55fba320bf7370588b356811b3f2556817f49098de467758ea4`.

## Building from source

```bash
./build.sh        # native build (Linux / macOS / Windows with DAML SDK installed)
./build-wsl.sh    # Windows + WSL — builds in /tmp for filesystem performance
```

Both scripts produce `release/canton-vc-credential-2.1.0.dar`,
overwriting the committed copy. The intermediate `.daml/dist/` build
artifact is gitignored.

## Templates at a glance

```
Canton.VC.Credential.Credential                       implements Cip204.Standard.Credential
├── signatories: issuer, holder                       (joint signatory per CIP #204)
├── observers:   admin
├── fields:      issuer, holder, admin, claims, createdAt, expiresAt, meta
├── nonconsuming Credential_PublicFetch : CredentialView          (CIP #204, controller actor)
├── consuming    Credential_ArchiveAsHolder : Credential_ArchiveAsHolderResult   (CIP #204, controller holder)
├── consuming    RevokeCredential : ContractId Credential         (implementer extension, controller issuer; cascade-burns bound KycNFT)
└── consuming    UpdateCredentials : ContractId Credential        (implementer extension, controller issuer; bulk claims + expiresAt replacement, stamps update.reason)

Canton.VC.Credential.KycNFT                           (optional implementer companion; NOT part of CIP #204)
├── signatories: issuer
├── observers:   customer
├── fields:      issuer, customer, boundCredentialId, issuedAt,
│                level, serialNumber, displayName, image
└── consuming    BurnNft : ()                         (controller issuer)
```

## Compatibility with legacy operators

If a participant already hosts an earlier package with structurally
equivalent templates (for example a predecessor module under a
different package id), that package stays in the participant store
and existing on-chain credentials continue to verify correctly via
the legacy verification path. New issuers — and existing operators'
new mints — use this canonical `canton-vc-credential` package.
Multiple DARs can coexist on the same participant.

## License

Apache 2.0 — see [LICENSE](../../../LICENSE).
