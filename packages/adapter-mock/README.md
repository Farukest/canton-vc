# @canton-vc/adapter-mock

Deterministic mock [`KycProvider`](https://www.npmjs.com/package/@canton-vc/kyc-provider) implementation for tests and local development. No network calls, no external dependencies — drop in for CI runs, integration tests, and demo deployments.

```ts
import { MockKycProvider } from '@canton-vc/adapter-mock';

const kyc = new MockKycProvider({
  // Rule-based response config — every test gets deterministic output.
  defaultStatus: 'approved',
});
```

See the [canton-vc repository](https://github.com/Farukest/canton-vc) for the production adapter family (Didit, Sumsub, Persona).

## License

Apache 2.0 — see [LICENSE](https://github.com/Farukest/canton-vc/blob/main/LICENSE).
