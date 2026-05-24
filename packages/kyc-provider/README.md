# @canton-vc/kyc-provider

Generic `KycProvider` interface for [canton-vc](https://github.com/Farukest/canton-vc) — the vendor-agnostic contract that issuer pipelines depend on, so the choice of KYC vendor stays a one-line constructor swap.

Implemented by:
- [`@canton-vc/adapter-didit`](https://www.npmjs.com/package/@canton-vc/adapter-didit)
- [`@canton-vc/adapter-sumsub`](https://www.npmjs.com/package/@canton-vc/adapter-sumsub)
- [`@canton-vc/adapter-persona`](https://www.npmjs.com/package/@canton-vc/adapter-persona)
- [`@canton-vc/adapter-mock`](https://www.npmjs.com/package/@canton-vc/adapter-mock) (dev/test)

```ts
import type { KycProvider, KycDecision, KycSession } from '@canton-vc/kyc-provider';

const kyc: KycProvider = new DiditAdapter({ /* config */ });
const session = await kyc.startSession({ userRef: 'user-123' });
const decision = await kyc.fetchDecision(session.sessionId);
```

See the [canton-vc repository](https://github.com/Farukest/canton-vc) for the full integration story.

## License

Apache 2.0 — see [LICENSE](https://github.com/Farukest/canton-vc/blob/main/LICENSE).
