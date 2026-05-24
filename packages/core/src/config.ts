/**
 * Env-backed Canton V2 JSON Ledger client configuration.
 *
 * A single object carries every tunable for the Canton client. The
 * object is built by `loadCantonConfig()` from a plain record
 * (defaulted from `process.env`) and is validated with Zod: no helper
 * in the Canton layer ever reads `process.env` directly. This has two
 * payoffs:
 *
 *   1. Tests can call helpers with a locally-built config (short
 *      timeouts, in-memory fetch stub, fake operator party) without
 *      monkey-patching globals.
 *   2. Production code always goes through `getCantonConfig()`, which
 *      caches the validated object per Node process so repeated reads
 *      do not re-parse the environment on every request.
 *
 * The config is split into four sections:
 *
 *   * Transport — base URL, auth token, request timeout, retries
 *   * Ledger    — operator party, user ID, package name, network
 *   * Commands  — command id prefix, max command size
 *   * Behavior  — whether to allocate parties on-demand
 *
 * Field defaults match the deployment notes in `PLAN.md` §15 (autossh
 * tunnel → 127.0.0.1:7676 → canton-participant:7575, auth disabled on
 * MainNet, 10s request timeout, 2 retries on idempotent reads).
 */

import { z } from 'zod';

import { CantonError } from './errors';

/* ---------- Zod schema ---------- */

const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * Canton package-name reference. V2 API requires the full package-name
 * qualified template identifier since Canton 3.4:
 *
 *     #<package-name>:<Module.Path>:<Template>
 *
 * Example:  `#canton-vc-credential:Canton.VC.Credential:Credential`
 *
 * The leading `#` is required. We pin the regex so a typo in
 * `CANTON_PACKAGE_NAME` fails at boot rather than on the first submit.
 */
export const PACKAGE_NAME_REGEX = /^#[a-zA-Z0-9][a-zA-Z0-9_-]*:[A-Z][\w.]*:[A-Z][\w]*$/;

const packageNameSchema = z
  .string()
  .regex(PACKAGE_NAME_REGEX, {
    message: 'Template ID must match `#<package-name>:<Module.Path>:<Template>`.',
  })
  .max(512);

/**
 * Canton base URL. The participant's JSON API runs on plain HTTP on
 * MainNet (auth disabled, docker-internal hostname reachable via the
 * autossh forward tunnel on the backend host). HTTPS is also accepted
 * for deployments that front the participant behind a TLS proxy.
 */
const baseUrlSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'CANTON_JSON_API_BASE_URL must be a valid http(s) URL.' },
  )
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * Operator party shape: `<Label>::<fingerprint>` where fingerprint is
 * a hex SHA-256 (64 chars) prefixed with the Canton version tag
 * (`1220…` for the current namespace). We validate shape only, not the
 * actual cryptographic content — the participant is the authority.
 */
const partyIdSchema = z
  .string()
  .min(3)
  .max(512)
  .refine((value) => value.includes('::') && value.split('::').length === 2, {
    message: 'Party ID must be `<label>::<fingerprint>`.',
  })
  .refine(
    (value) => {
      const parts = value.split('::');
      return parts.every((segment) => segment.length > 0);
    },
    { message: 'Party ID segments cannot be empty.' },
  );

/**
 * Canton network tag. Matches the `canonical_network` DB enum
 * (`mainnet` | `devnet`) and is stamped onto every credential payload
 * so disclosure verifiers on the firm side can assert which network
 * the credential was issued on.
 */
const networkSchema = z.enum(['mainnet', 'devnet']);

export const CantonConfigSchema = z.object({
  /* Transport */
  baseUrl: baseUrlSchema,
  authToken: z.string().min(1).nullable(),
  requestTimeoutMs: PositiveInt.max(120_000), // hard ceiling: 2 minutes
  // Submit-and-wait commands (allocate-and-mint, choice exercise) hold
  // the connection open until the participant has confirmed the tx on
  // the synchronizer, which on DevNet through an SSH tunnel routinely
  // takes 5-30s and can spike above 60s under contention. Keeping a
  // single global timeout forces a Hobson's choice: either fail-fast
  // probes (livez, party query) get a generous ceiling (slow detection
  // of a stalled participant) OR submit-and-wait gets the same short
  // ceiling as fast probes (false negatives on healthy commits). The
  // dedicated `submitTimeoutMs` lets us keep `requestTimeoutMs` at 10s
  // for fast paths and lift only the submit branch to 90s.
  submitTimeoutMs: PositiveInt.max(120_000),
  maxRetries: NonNegativeInt.max(5),
  retryBaseDelayMs: NonNegativeInt.max(5_000),

  /* Ledger */
  operatorParty: partyIdSchema,
  userId: z.string().min(1).max(256),
  packageName: packageNameSchema,
  network: networkSchema,
  networkLabel: z.string().min(1).max(64),

  /* Commands */
  commandIdPrefix: z.string().min(1).max(32),
  maxCommandBodyBytes: PositiveInt.max(1_048_576), // 1 MiB

  /* Behavior */
  allocateMissingParties: z.boolean(),
});

export type CantonConfig = z.infer<typeof CantonConfigSchema>;

/* ---------- Defaults ---------- */

/**
 * Fallback values applied when the matching env var is unset. Values
 * that carry infrastructure identity (base URL, operator party) have
 * no default and must be provided by the caller.
 */
const DEFAULTS = {
  CANTON_REQUEST_TIMEOUT_MS: '10000', // 10 seconds — fast probes (livez, parties)
  CANTON_SUBMIT_TIMEOUT_MS: '90000', // 90 seconds — submit-and-wait commits
  CANTON_MAX_RETRIES: '2',
  CANTON_RETRY_BASE_DELAY_MS: '250',
  CANTON_USER_ID: 'canton-vc-api',
  CANTON_PACKAGE_NAME: '#canton-vc-credential:Canton.VC.Credential:Credential',
  CANTON_NETWORK: 'mainnet',
  CANTON_NETWORK_LABEL: 'Canton MainNet',
  CANTON_COMMAND_ID_PREFIX: 'crv',
  CANTON_MAX_COMMAND_BODY_BYTES: '65536', // 64 KiB — plenty for our template
  CANTON_ALLOCATE_MISSING_PARTIES: 'false',
} as const;

export type CantonRequiredEnv = 'CANTON_JSON_API_BASE_URL' | 'CANTON_OPERATOR_PARTY';

/**
 * Union of the env keys we read. Declared explicitly so a typo in a
 * caller's override dictionary is a compile-time error.
 */
export type CantonEnv = Partial<
  Record<keyof typeof DEFAULTS | CantonRequiredEnv | 'CANTON_AUTH_TOKEN', string | undefined>
>;

/* ---------- Loader ---------- */

/**
 * Build a validated `CantonConfig` from an environment record.
 *
 * The caller can either pass an explicit record (used by tests) or
 * omit the argument to read `process.env`. The returned object is
 * frozen so it cannot be mutated in place.
 *
 * Validation errors are collected into a single `invalid_config`
 * error whose `cause` is the underlying `ZodError` so callers can
 * inspect individual issues through the observability pipeline.
 */
export function loadCantonConfig(env: CantonEnv = process.env as CantonEnv): CantonConfig {
  // Empty-string env values are treated as "unset" so the default
  // applies. This guards against a common .env pitfall where dotenv
  // strips an inline `#` (e.g. an unquoted `CANTON_PACKAGE_NAME=#pkg:…`
  // becomes ""), which would otherwise pass through `??` and trigger
  // a misleading "regex" validation error downstream.
  const pick = <K extends keyof typeof DEFAULTS>(key: K): string => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0 ? value : DEFAULTS[key];
  };

  const baseUrl = env.CANTON_JSON_API_BASE_URL;
  const operator = env.CANTON_OPERATOR_PARTY;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new CantonError(
      'invalid_config',
      'CANTON_JSON_API_BASE_URL is required (e.g. http://127.0.0.1:7676 for the autossh tunnel).',
    );
  }
  if (typeof operator !== 'string' || operator.length === 0) {
    throw new CantonError(
      'invalid_config',
      'CANTON_OPERATOR_PARTY is required (e.g. Operator::1220deadbeef...).',
    );
  }

  // CANTON_AUTH_TOKEN is optional — MainNet runs with auth disabled,
  // so the token may be unset. An empty string is treated as absent.
  const rawToken = env.CANTON_AUTH_TOKEN;
  const authToken = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;

  // Boolean env parsing: treat '1' | 'true' | 'yes' as true, everything
  // else (including empty) as false. This lets tests flip the behavior
  // flag without monkey-patching.
  const allocateFlag = pick('CANTON_ALLOCATE_MISSING_PARTIES').toLowerCase();
  const allocateMissingParties =
    allocateFlag === '1' || allocateFlag === 'true' || allocateFlag === 'yes';

  const raw = {
    baseUrl,
    authToken,
    requestTimeoutMs: pick('CANTON_REQUEST_TIMEOUT_MS'),
    submitTimeoutMs: pick('CANTON_SUBMIT_TIMEOUT_MS'),
    maxRetries: pick('CANTON_MAX_RETRIES'),
    retryBaseDelayMs: pick('CANTON_RETRY_BASE_DELAY_MS'),
    operatorParty: operator,
    userId: pick('CANTON_USER_ID'),
    packageName: pick('CANTON_PACKAGE_NAME'),
    network: pick('CANTON_NETWORK'),
    networkLabel: pick('CANTON_NETWORK_LABEL'),
    commandIdPrefix: pick('CANTON_COMMAND_ID_PREFIX'),
    maxCommandBodyBytes: pick('CANTON_MAX_COMMAND_BODY_BYTES'),
    allocateMissingParties,
  };

  const parsed = CantonConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CantonError(
      'invalid_config',
      `Canton config validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}

/* ---------- Per-process cache ---------- */

let cached: CantonConfig | null = null;

/**
 * Return the singleton config for the current process. Built lazily
 * on the first call. Tests can call `resetCantonConfigForTests()` to
 * drop the cache between cases.
 */
export function getCantonConfig(): CantonConfig {
  if (cached === null) {
    cached = loadCantonConfig();
  }
  return cached;
}

/**
 * Drop the cached config. Only for test suites that mutate the
 * environment between cases.
 */
export function resetCantonConfigForTests(): void {
  cached = null;
}
