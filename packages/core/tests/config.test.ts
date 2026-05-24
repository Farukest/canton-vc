/**
 * Tests for `./src/config`.
 *
 * The config loader is the boundary between process env and the rest
 * of the Canton client. Everything downstream trusts it blindly, so
 * these tests exercise every validation rule end-to-end:
 *
 *   * Required fields present → `CantonConfig` frozen and typed.
 *   * Required fields missing → `invalid_config` with a clear message.
 *   * Bad URL → `invalid_config`, surfaces ZodError as `cause`.
 *   * Bad package name → `invalid_config`, regex failure.
 *   * Bad party shape → `invalid_config`, split on `::` invariant.
 *   * Numeric bounds (timeouts, retries, command body).
 *   * Boolean env parsing (`1`, `true`, `yes`, case-insensitive).
 *   * Empty / whitespace `CANTON_AUTH_TOKEN` normalized to `null`.
 *   * `getCantonConfig()` caches across calls, `resetCantonConfigForTests()`
 *     clears the cache.
 *   * Default values applied when the corresponding env var is unset.
 *
 * No network, no I/O — we only exercise `loadCantonConfig(env)` with
 * explicit records. This avoids any `process.env` mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CantonEnv } from '../src';
import {
  CantonError,
  getCantonConfig,
  isCantonErrorWithCode,
  loadCantonConfig,
  PACKAGE_NAME_REGEX,
  resetCantonConfigForTests,
} from '../src';

const VALID_BASE: Required<Pick<CantonEnv, 'CANTON_JSON_API_BASE_URL' | 'CANTON_OPERATOR_PARTY'>> =
  {
    CANTON_JSON_API_BASE_URL: 'http://127.0.0.1:7676',
    CANTON_OPERATOR_PARTY:
      'Operator::1220deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0011',
  };

function env(overrides: CantonEnv = {}): CantonEnv {
  return { ...VALID_BASE, ...overrides };
}

describe('loadCantonConfig — happy path', () => {
  it('returns a frozen CantonConfig with the provided base values', () => {
    const config = loadCantonConfig(env());
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.baseUrl).toBe('http://127.0.0.1:7676');
    expect(config.operatorParty).toBe(VALID_BASE.CANTON_OPERATOR_PARTY);
  });

  it('applies defaults for every optional field', () => {
    const config = loadCantonConfig(env());
    expect(config.requestTimeoutMs).toBe(10000);
    expect(config.submitTimeoutMs).toBe(90000);
    expect(config.maxRetries).toBe(2);
    expect(config.retryBaseDelayMs).toBe(250);
    expect(config.userId).toBe('canton-vc-api');
    expect(config.packageName).toBe('#canton-vc-credential:Canton.VC.Credential:Credential');
    expect(config.network).toBe('mainnet');
    expect(config.networkLabel).toBe('Canton MainNet');
    expect(config.commandIdPrefix).toBe('crv');
    expect(config.maxCommandBodyBytes).toBe(65536);
    expect(config.allocateMissingParties).toBe(false);
    expect(config.authToken).toBeNull();
  });

  it('strips trailing slashes from the base URL', () => {
    const config = loadCantonConfig(
      env({ CANTON_JSON_API_BASE_URL: 'http://example.test:7575//' }),
    );
    expect(config.baseUrl).toBe('http://example.test:7575');
  });

  it('accepts https URLs', () => {
    const config = loadCantonConfig(
      env({ CANTON_JSON_API_BASE_URL: 'https://canton.example.test' }),
    );
    expect(config.baseUrl).toBe('https://canton.example.test');
  });

  it('overrides defaults when explicit env vars are set', () => {
    const config = loadCantonConfig(
      env({
        CANTON_REQUEST_TIMEOUT_MS: '5000',
        CANTON_SUBMIT_TIMEOUT_MS: '45000',
        CANTON_MAX_RETRIES: '1',
        CANTON_RETRY_BASE_DELAY_MS: '100',
        CANTON_USER_ID: 'custom-user',
        CANTON_PACKAGE_NAME: '#other:Module:Template',
        CANTON_NETWORK: 'devnet',
        CANTON_NETWORK_LABEL: 'Canton DevNet',
        CANTON_COMMAND_ID_PREFIX: 'xyz',
        CANTON_MAX_COMMAND_BODY_BYTES: '131072',
      }),
    );
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.submitTimeoutMs).toBe(45000);
    expect(config.maxRetries).toBe(1);
    expect(config.retryBaseDelayMs).toBe(100);
    expect(config.userId).toBe('custom-user');
    expect(config.packageName).toBe('#other:Module:Template');
    expect(config.network).toBe('devnet');
    expect(config.networkLabel).toBe('Canton DevNet');
    expect(config.commandIdPrefix).toBe('xyz');
    expect(config.maxCommandBodyBytes).toBe(131072);
  });

  it('maps a non-empty auth token to the string and empty to null', () => {
    const withToken = loadCantonConfig(env({ CANTON_AUTH_TOKEN: 'secret-token' }));
    expect(withToken.authToken).toBe('secret-token');

    const withEmpty = loadCantonConfig(env({ CANTON_AUTH_TOKEN: '' }));
    expect(withEmpty.authToken).toBeNull();

    const withUndefined = loadCantonConfig(env({ CANTON_AUTH_TOKEN: undefined }));
    expect(withUndefined.authToken).toBeNull();
  });

  it('parses allocate-missing-parties as true for truthy values', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'True', 'yes', 'YES']) {
      const config = loadCantonConfig(env({ CANTON_ALLOCATE_MISSING_PARTIES: truthy }));
      expect(config.allocateMissingParties).toBe(true);
    }
  });

  it('parses allocate-missing-parties as false for everything else', () => {
    for (const falsy of ['0', 'false', 'no', '', 'maybe', 'off']) {
      const config = loadCantonConfig(env({ CANTON_ALLOCATE_MISSING_PARTIES: falsy }));
      expect(config.allocateMissingParties).toBe(false);
    }
  });
});

describe('loadCantonConfig — required fields', () => {
  it('throws invalid_config when CANTON_JSON_API_BASE_URL is missing', () => {
    expect(() =>
      loadCantonConfig({
        CANTON_OPERATOR_PARTY: VALID_BASE.CANTON_OPERATOR_PARTY,
      }),
    ).toThrow(CantonError);
    try {
      loadCantonConfig({ CANTON_OPERATOR_PARTY: VALID_BASE.CANTON_OPERATOR_PARTY });
    } catch (err) {
      expect(isCantonErrorWithCode(err, 'invalid_config')).toBe(true);
      expect((err as CantonError).message).toMatch(/CANTON_JSON_API_BASE_URL/);
    }
  });

  it('throws invalid_config when CANTON_JSON_API_BASE_URL is empty', () => {
    expect(() => loadCantonConfig(env({ CANTON_JSON_API_BASE_URL: '' }))).toThrowError(
      /CANTON_JSON_API_BASE_URL/,
    );
  });

  it('throws invalid_config when CANTON_OPERATOR_PARTY is missing', () => {
    expect(() =>
      loadCantonConfig({ CANTON_JSON_API_BASE_URL: VALID_BASE.CANTON_JSON_API_BASE_URL }),
    ).toThrowError(/CANTON_OPERATOR_PARTY/);
  });

  it('throws invalid_config when CANTON_OPERATOR_PARTY is empty', () => {
    expect(() => loadCantonConfig(env({ CANTON_OPERATOR_PARTY: '' }))).toThrowError(
      /CANTON_OPERATOR_PARTY/,
    );
  });
});

describe('loadCantonConfig — field validation', () => {
  it('rejects a non-http(s) base URL', () => {
    expect(() =>
      loadCantonConfig(env({ CANTON_JSON_API_BASE_URL: 'ftp://canton.example' })),
    ).toThrowError(/http\(s\) URL/);
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadCantonConfig(env({ CANTON_JSON_API_BASE_URL: 'not-a-url' }))).toThrowError(
      /http\(s\) URL/,
    );
  });

  it('rejects a package name missing the leading #', () => {
    expect(() =>
      loadCantonConfig(env({ CANTON_PACKAGE_NAME: 'test-pkg:Test.KYC:KYC' })),
    ).toThrowError(/Template ID/);
  });

  it('rejects a package name with lowercase module', () => {
    expect(() =>
      loadCantonConfig(env({ CANTON_PACKAGE_NAME: '#test-pkg:test.KYC:KYC' })),
    ).toThrowError(/Template ID/);
  });

  it('rejects a package name with missing template segment', () => {
    expect(() =>
      loadCantonConfig(env({ CANTON_PACKAGE_NAME: '#test-pkg:Test.KYC' })),
    ).toThrowError(/Template ID/);
  });

  it('rejects a party id missing the :: separator', () => {
    expect(() => loadCantonConfig(env({ CANTON_OPERATOR_PARTY: 'Operator' }))).toThrowError(
      /label.*fingerprint|::/,
    );
  });

  it('rejects a party id with empty segments', () => {
    expect(() => loadCantonConfig(env({ CANTON_OPERATOR_PARTY: '::abc' }))).toThrow(CantonError);
    expect(() => loadCantonConfig(env({ CANTON_OPERATOR_PARTY: 'abc::' }))).toThrow(CantonError);
  });

  it('rejects an unknown network tag', () => {
    expect(() => loadCantonConfig(env({ CANTON_NETWORK: 'testnet' }))).toThrowError(/network/);
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => loadCantonConfig(env({ CANTON_REQUEST_TIMEOUT_MS: 'soon' }))).toThrow(CantonError);
  });

  it('rejects a zero timeout (positive integer only)', () => {
    expect(() => loadCantonConfig(env({ CANTON_REQUEST_TIMEOUT_MS: '0' }))).toThrow(CantonError);
  });

  it('rejects a timeout over the 2-minute ceiling', () => {
    expect(() => loadCantonConfig(env({ CANTON_REQUEST_TIMEOUT_MS: '120001' }))).toThrow(
      CantonError,
    );
  });

  it('accepts the timeout ceiling exactly', () => {
    const config = loadCantonConfig(env({ CANTON_REQUEST_TIMEOUT_MS: '120000' }));
    expect(config.requestTimeoutMs).toBe(120000);
  });

  it('rejects a negative max retries', () => {
    expect(() => loadCantonConfig(env({ CANTON_MAX_RETRIES: '-1' }))).toThrow(CantonError);
  });

  it('rejects max retries above the cap', () => {
    expect(() => loadCantonConfig(env({ CANTON_MAX_RETRIES: '6' }))).toThrow(CantonError);
  });

  it('accepts maxRetries = 0', () => {
    const config = loadCantonConfig(env({ CANTON_MAX_RETRIES: '0' }));
    expect(config.maxRetries).toBe(0);
  });

  it('rejects a command body size over 1 MiB', () => {
    expect(() => loadCantonConfig(env({ CANTON_MAX_COMMAND_BODY_BYTES: '1048577' }))).toThrow(
      CantonError,
    );
  });

  it('falls back to the default prefix when CANTON_COMMAND_ID_PREFIX is empty', () => {
    // `loadCantonConfig` deliberately treats empty-string env values
    // as "unset" so the default applies (see the `pick` helper). This
    // guards against a common .env pitfall where dotenv strips inline
    // `#` characters and leaves the var at `''`. Asserting fallback
    // instead of rejection pins that design.
    const config = loadCantonConfig(env({ CANTON_COMMAND_ID_PREFIX: '' }));
    expect(config.commandIdPrefix).toBe('crv');
  });

  it('surfaces the ZodError as cause on validation failure', () => {
    try {
      loadCantonConfig(env({ CANTON_NETWORK: 'bogus' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CantonError);
      expect((err as CantonError).code).toBe('invalid_config');
      const cause = (err as unknown as { cause?: unknown }).cause;
      expect(cause).toBeDefined();
      expect((cause as { name?: string }).name).toMatch(/ZodError/);
    }
  });

  it('includes the offending field path in the message', () => {
    try {
      loadCantonConfig(env({ CANTON_NETWORK: 'bogus' }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CantonError).message).toContain('network');
    }
  });
});

describe('PACKAGE_NAME_REGEX', () => {
  it('accepts the canonical MainNet package name', () => {
    expect(PACKAGE_NAME_REGEX.test('#canton-vc-credential:Canton.VC.Credential:Credential')).toBe(true);
  });

  it('accepts package names with underscores and dashes', () => {
    expect(PACKAGE_NAME_REGEX.test('#pkg_name-1:Module.Sub:Template')).toBe(true);
  });

  it('rejects a missing leading #', () => {
    expect(PACKAGE_NAME_REGEX.test('test-pkg:Test:KYC')).toBe(false);
  });

  it('rejects a package name without a module', () => {
    expect(PACKAGE_NAME_REGEX.test('#pkg::Template')).toBe(false);
  });

  it('rejects a lowercase module name', () => {
    expect(PACKAGE_NAME_REGEX.test('#pkg:module:Template')).toBe(false);
  });

  it('rejects a lowercase template name', () => {
    expect(PACKAGE_NAME_REGEX.test('#pkg:Module:template')).toBe(false);
  });
});

describe('getCantonConfig cache', () => {
  beforeEach(() => {
    resetCantonConfigForTests();
  });
  afterEach(() => {
    resetCantonConfigForTests();
    // Do not leak env mutations outside the suite.
    delete process.env['CANTON_JSON_API_BASE_URL'];
    delete process.env['CANTON_OPERATOR_PARTY'];
    delete process.env['CANTON_AUTH_TOKEN'];
  });

  it('returns the same frozen object on repeated calls', () => {
    process.env['CANTON_JSON_API_BASE_URL'] = VALID_BASE.CANTON_JSON_API_BASE_URL;
    process.env['CANTON_OPERATOR_PARTY'] = VALID_BASE.CANTON_OPERATOR_PARTY;
    const a = getCantonConfig();
    const b = getCantonConfig();
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('rebuilds after resetCantonConfigForTests', () => {
    process.env['CANTON_JSON_API_BASE_URL'] = VALID_BASE.CANTON_JSON_API_BASE_URL;
    process.env['CANTON_OPERATOR_PARTY'] = VALID_BASE.CANTON_OPERATOR_PARTY;
    const first = getCantonConfig();
    resetCantonConfigForTests();
    process.env['CANTON_JSON_API_BASE_URL'] = 'http://other.test:7575';
    const second = getCantonConfig();
    expect(second).not.toBe(first);
    expect(second.baseUrl).toBe('http://other.test:7575');
  });

  it('throws invalid_config when called without required env', () => {
    resetCantonConfigForTests();
    delete process.env['CANTON_JSON_API_BASE_URL'];
    delete process.env['CANTON_OPERATOR_PARTY'];
    expect(() => getCantonConfig()).toThrow(CantonError);
  });
});
