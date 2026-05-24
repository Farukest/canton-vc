/**
 * Vendor-agnostic adapter factory for the issuer-demo CLI.
 *
 * Selects a `KycProvider` implementation at runtime from the
 * `CANTON_VC_VENDOR` env var. All four adapters (mock + three
 * production vendors) implement the same `KycProvider` interface, so
 * the rest of the demo treats them uniformly.
 *
 * In `mock` mode the returned provider is deterministic — no network
 * calls, no credentials needed. In `didit` / `sumsub` / `persona`
 * mode the returned provider makes real HTTPS requests to the
 * vendor's sandbox API; the demo's downstream flow is unchanged.
 *
 * @module
 */

import { DiditAdapter } from '@canton-vc/adapter-didit';
import { MockAdapter } from '@canton-vc/adapter-mock';
import { PersonaAdapter } from '@canton-vc/adapter-persona';
import { SumsubAdapter } from '@canton-vc/adapter-sumsub';
import type { KycProvider } from '@canton-vc/kyc-provider';

export type VendorId = 'mock' | 'didit' | 'sumsub' | 'persona';

export function resolveVendor(raw: string | undefined): VendorId {
  switch (raw) {
    case 'mock':
    case undefined:
    case '':
      return 'mock';
    case 'didit':
      return 'didit';
    case 'sumsub':
      return 'sumsub';
    case 'persona':
      return 'persona';
    default:
      throw new Error(
        `Unknown CANTON_VC_VENDOR="${raw}". Expected one of: mock, didit, sumsub, persona.`,
      );
  }
}

function required(env: NodeJS.ProcessEnv, key: string, vendor: VendorId): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing env var ${key}. Required when CANTON_VC_VENDOR=${vendor}. ` +
        'See .env.example for the full list of vendor-specific variables.',
    );
  }
  return value;
}

export function buildAdapter(
  vendor: VendorId,
  env: NodeJS.ProcessEnv = process.env,
): KycProvider {
  switch (vendor) {
    case 'mock':
      return new MockAdapter({ defaultDecisionStatus: 'approved' });

    case 'didit': {
      const config: ConstructorParameters<typeof DiditAdapter>[0] = {
        apiKey: required(env, 'DIDIT_API_KEY', 'didit'),
        webhookSecret: required(env, 'DIDIT_WEBHOOK_SECRET', 'didit'),
        kycWorkflowId: required(env, 'DIDIT_KYC_WORKFLOW_ID', 'didit'),
      };
      if (typeof env['DIDIT_BASE_URL'] === 'string' && env['DIDIT_BASE_URL'].length > 0) {
        return new DiditAdapter({ ...config, baseUrl: env['DIDIT_BASE_URL'] });
      }
      return new DiditAdapter(config);
    }

    case 'sumsub': {
      const config: ConstructorParameters<typeof SumsubAdapter>[0] = {
        appToken: required(env, 'SUMSUB_APP_TOKEN', 'sumsub'),
        secretKey: required(env, 'SUMSUB_SECRET_KEY', 'sumsub'),
        webhookSecret: required(env, 'SUMSUB_WEBHOOK_SECRET', 'sumsub'),
        identityLevelName: required(env, 'SUMSUB_LEVEL_NAME_IDENTITY', 'sumsub'),
      };
      if (typeof env['SUMSUB_BASE_URL'] === 'string' && env['SUMSUB_BASE_URL'].length > 0) {
        return new SumsubAdapter({ ...config, baseUrl: env['SUMSUB_BASE_URL'] });
      }
      return new SumsubAdapter(config);
    }

    case 'persona': {
      // Persona's adapter takes a single webhookSecret. Users with
      // active key rotation can paste the currently-active secret here
      // for the demo's single-event flow.
      const config: ConstructorParameters<typeof PersonaAdapter>[0] = {
        apiKey: required(env, 'PERSONA_API_KEY', 'persona'),
        webhookSecret: required(env, 'PERSONA_WEBHOOK_SECRETS', 'persona'),
        identityTemplateId: required(env, 'PERSONA_TEMPLATE_ID', 'persona'),
      };
      if (typeof env['PERSONA_BASE_URL'] === 'string' && env['PERSONA_BASE_URL'].length > 0) {
        return new PersonaAdapter({ ...config, baseUrl: env['PERSONA_BASE_URL'] });
      }
      return new PersonaAdapter(config);
    }
  }
}
