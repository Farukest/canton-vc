# Proof Schema Registry

Content-addressed proof schemas the canton-vc adapters reference at issuance.
On-chain `proofSchemaId` (in `Canton.VC.Credential.proofSchemaId`) maps to the
`<id>.json` file in this directory. Auditors load the spec from the file name,
apply the canonical pipeline (`@canton-vc/core#canonicalJson` + SHA-256) to the
firm's retained raw bytes, and compare against the on-chain `proofHash`.

| Vendor | Version | Schema ID | File |
|---|---|---|---|
| didit | v1 | `c10ccf18f6c20a5515ca0ab761ebd1099ba54fe0732a33fa903bdcd04c386a54` | [`c10ccf18f6c20a55…`](./c10ccf18f6c20a5515ca0ab761ebd1099ba54fe0732a33fa903bdcd04c386a54.json) |
| sumsub | v1 | `37ab981a4e069457011fee7b4100cf5547697478daaf31a0a40ed3f418e5b26f` | [`37ab981a4e069457…`](./37ab981a4e069457011fee7b4100cf5547697478daaf31a0a40ed3f418e5b26f.json) |
| persona | v1 | `c03e0f227a17bb3371af872d1247123cb52670de0d228e5d2fa78a25f4e947e9` | [`c03e0f227a17bb33…`](./c03e0f227a17bb3371af872d1247123cb52670de0d228e5d2fa78a25f4e947e9.json) |
