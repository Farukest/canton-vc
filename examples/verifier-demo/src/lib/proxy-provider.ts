/**
 * Browser-side `KycProvider` that delegates to the Vite vendor-proxy.
 *
 * Implements the same `KycProvider` interface as the real adapters,
 * but instead of speaking the vendor's wire protocol directly (which
 * would require server-side secrets in the browser bundle), it POSTs
 * a JSON request to the proxy endpoint exposed by
 * `vite-vendor-proxy-plugin.ts`. The plugin reads vendor credentials
 * from the Node process's `.env`, instantiates the real
 * `@canton-vc/adapter-*` class, calls the method, and forwards the
 * result.
 *
 * From the SDK's perspective the call site is identical: the
 * `KycProvider` interface contract is preserved. The proxy is a
 * transport detail, not a behavior change.
 *
 * Webhook verification (`verifyWebhook`) is not proxied — webhooks
 * are an out-of-band server-side concern. The browser demo polls
 * `fetchDecision` instead.
 *
 * @module
 */

import type {
  KycDecision,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '@canton-vc/kyc-provider';

export type ProxyVendor = 'didit' | 'sumsub' | 'persona';

export class ProxyVendorProvider implements KycProvider {
  readonly vendorName: string;
  readonly #vendor: ProxyVendor;

  constructor(vendor: ProxyVendor) {
    this.#vendor = vendor;
    this.vendorName = vendor.charAt(0).toUpperCase() + vendor.slice(1);
  }

  async startSession(options: StartSessionOptions): Promise<KycSession> {
    const payload: Record<string, unknown> = {
      vendor: this.#vendor,
      userRef: options.userRef,
    };
    if (options.workflow !== undefined) {
      payload['workflow'] = options.workflow;
    }
    const res = await fetch('/api/vendor/start-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await unwrap(res, `${this.#vendor}.startSession`)) as KycSession;
  }

  async fetchDecision(sessionId: string): Promise<KycDecision> {
    const res = await fetch('/api/vendor/fetch-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor: this.#vendor, sessionId }),
    });
    return (await unwrap(res, `${this.#vendor}.fetchDecision`)) as KycDecision;
  }

  async verifyWebhook(): Promise<KycWebhookEvent | null> {
    // Webhooks are server-side; not exposed via the browser proxy.
    return null;
  }
}

async function unwrap(res: Response, scope: string): Promise<unknown> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const errorMessage =
      typeof json === 'object' && json !== null && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status} (${text.slice(0, 120)})`;
    throw new Error(
      `Vendor proxy ${scope} failed: ${errorMessage}. ` +
        'Check that the Vite dev server has matching credentials in .env ' +
        '(see .env.example for the required vars).',
    );
  }
  return json;
}
