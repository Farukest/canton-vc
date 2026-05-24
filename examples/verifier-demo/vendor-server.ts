/**
 * Standalone Node-side proxy that lets the verifier-demo SPA call
 * real KYC vendor sandbox APIs without leaking credentials into the
 * browser bundle.
 *
 * Why standalone (not a Vite plugin):
 *
 *   The plugin route hit Vite's config-load Node-native ESM resolver,
 *   which refused to follow `@canton-vc/adapter-*`'s extensionless
 *   relative imports (`./adapter`, `./errors`). A standalone tsx
 *   process resolves them correctly out of the box — and `concurrently`
 *   starts both this server and `vite` from a single `pnpm dev`.
 *
 * Vite is configured to proxy `/api/vendor/*` to `localhost:5174`,
 * so the SPA's `fetch('/api/vendor/start-session', ...)` lands here.
 * This server then:
 *
 *   - Reads vendor credentials from the Node `.env` (`DIDIT_API_KEY`,
 *     `SUMSUB_SECRET_KEY`, `PERSONA_API_KEY`, etc.).
 *   - Instantiates the real `@canton-vc/adapter-*` class.
 *   - Calls the SDK method (`startSession` / `fetchDecision`) which
 *     does HMAC signing + Persona-Version pinning + Sumsub digest
 *     internally.
 *   - Returns the parsed JSON response.
 *
 * Keys never reach the browser. Sumsub's HMAC secret never reaches
 * the browser. The SPA only sees the post-vendor wire output.
 *
 * @module
 */

/* eslint-disable no-console */

import { config as loadDotenv } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { DiditAdapter } from '@canton-vc/adapter-didit';
import { PersonaAdapter } from '@canton-vc/adapter-persona';
import { SumsubAdapter } from '@canton-vc/adapter-sumsub';
import type { KycProvider } from '@canton-vc/kyc-provider';

loadDotenv({ quiet: true });

type VendorId = 'didit' | 'sumsub' | 'persona';

const PORT = Number(process.env['VENDOR_SERVER_PORT'] ?? 5174);

function isVendor(v: unknown): v is VendorId {
  return v === 'didit' || v === 'sumsub' || v === 'persona';
}

function required(key: string, vendor: VendorId): string {
  const v = process.env[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(
      `Missing env var ${key}. Required when vendor=${vendor}. ` +
        'Copy .env.example to .env and paste your sandbox credentials.',
    );
  }
  return v;
}

function buildAdapter(vendor: VendorId): KycProvider {
  switch (vendor) {
    case 'didit': {
      const config: ConstructorParameters<typeof DiditAdapter>[0] = {
        apiKey: required('DIDIT_API_KEY', 'didit'),
        webhookSecret: required('DIDIT_WEBHOOK_SECRET', 'didit'),
        kycWorkflowId: required('DIDIT_KYC_WORKFLOW_ID', 'didit'),
      };
      const baseUrl = process.env['DIDIT_BASE_URL'];
      if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        return new DiditAdapter({ ...config, baseUrl });
      }
      return new DiditAdapter(config);
    }
    case 'sumsub': {
      const config: ConstructorParameters<typeof SumsubAdapter>[0] = {
        appToken: required('SUMSUB_APP_TOKEN', 'sumsub'),
        secretKey: required('SUMSUB_SECRET_KEY', 'sumsub'),
        webhookSecret: required('SUMSUB_WEBHOOK_SECRET', 'sumsub'),
        identityLevelName: required('SUMSUB_LEVEL_NAME_IDENTITY', 'sumsub'),
      };
      const baseUrl = process.env['SUMSUB_BASE_URL'];
      if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        return new SumsubAdapter({ ...config, baseUrl });
      }
      return new SumsubAdapter(config);
    }
    case 'persona': {
      const config: ConstructorParameters<typeof PersonaAdapter>[0] = {
        apiKey: required('PERSONA_API_KEY', 'persona'),
        webhookSecret: required('PERSONA_WEBHOOK_SECRETS', 'persona'),
        identityTemplateId: required('PERSONA_TEMPLATE_ID', 'persona'),
      };
      const baseUrl = process.env['PERSONA_BASE_URL'];
      if (typeof baseUrl === 'string' && baseUrl.length > 0) {
        return new PersonaAdapter({ ...config, baseUrl });
      }
      return new PersonaAdapter(config);
    }
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      buf += c;
      if (buf.length > 1024 * 64) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(buf.length > 0 ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function writeCorsPreflight(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end();
}

async function handleStartSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (!isVendor(body['vendor'])) {
    writeJson(res, 400, { error: 'vendor must be didit | sumsub | persona' });
    return;
  }
  if (typeof body['userRef'] !== 'string' || body['userRef'].length === 0) {
    writeJson(res, 400, { error: 'userRef must be a non-empty string' });
    return;
  }
  const workflow = body['workflow'];
  if (workflow !== undefined && workflow !== 'identity' && workflow !== 'address') {
    writeJson(res, 400, { error: 'workflow must be identity | address' });
    return;
  }
  const adapter = buildAdapter(body['vendor']);
  const session = await adapter.startSession({
    userRef: body['userRef'],
    ...(workflow !== undefined ? { workflow } : {}),
  });
  writeJson(res, 200, session);
}

async function handleFetchDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (!isVendor(body['vendor'])) {
    writeJson(res, 400, { error: 'vendor must be didit | sumsub | persona' });
    return;
  }
  if (typeof body['sessionId'] !== 'string' || body['sessionId'].length === 0) {
    writeJson(res, 400, { error: 'sessionId must be a non-empty string' });
    return;
  }
  const adapter = buildAdapter(body['vendor']);
  const decision = await adapter.fetchDecision(body['sessionId']);
  writeJson(res, 200, decision);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeCorsPreflight(res);
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const route = req.url ?? '';
  const handler =
    route.startsWith('/api/vendor/start-session')
      ? handleStartSession
      : route.startsWith('/api/vendor/fetch-decision')
        ? handleFetchDecision
        : null;
  if (handler === null) {
    writeJson(res, 404, { error: 'not found' });
    return;
  }
  handler(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[vendor-server] ${route} failed:`, message);
    writeJson(res, 400, { error: message });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[vendor-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[vendor-server] credentials present:`);
  console.log(`  DIDIT_API_KEY:       ${process.env['DIDIT_API_KEY'] !== undefined ? 'yes' : 'no'}`);
  console.log(`  SUMSUB_APP_TOKEN:    ${process.env['SUMSUB_APP_TOKEN'] !== undefined ? 'yes' : 'no'}`);
  console.log(`  PERSONA_API_KEY:     ${process.env['PERSONA_API_KEY'] !== undefined ? 'yes' : 'no'}`);
});
