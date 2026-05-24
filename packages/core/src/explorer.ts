/**
 * Canton Explorer URL builder — single source of truth for surfacing
 * `kyc_credentials_meta.canton_contract_id` (and other on-chain ids)
 * as clickable links across admin, customer, and dashboard surfaces.
 *
 * Why centralise:
 *   - Three surfaces today (admin customer detail, customer credential
 *     page, dashboard B2B inspection) and no shared module → each was
 *     formatting raw contract ids as monospace text and offering no
 *     way to verify the on-chain artefact. Reusing one helper means
 *     the explorer host can change in env config without a code sweep.
 *   - Network-scoped: a contract id only resolves on the network it
 *     was minted on. The explorer URL therefore branches on the row's
 *     `cantonNetwork` value (`devnet` / `mainnet`), not on a global
 *     constant.
 *
 * Configuration:
 *   - `NEXT_PUBLIC_CANTON_EXPLORER_BASE_<NETWORK>` — per-network base
 *     URL. `<NETWORK>` is upper-cased (`MAINNET`, `DEVNET`, `LOCAL`).
 *     Trailing slashes are stripped so the helper can append cleanly.
 *   - Falls back to the well-known Splice scan host for `mainnet` and
 *     `devnet` — those are public and stable. `local` defaults to
 *     `null` (no link).
 *
 * Returns `null` when:
 *   - `cantonContractId` is empty / null
 *   - the network is unknown and no env override is set
 *   The caller renders the contract id as plain monospace text in
 *   that case (no broken anchor).
 */

/**
 * Per-network default explorer base. ccview.io hosts a public Canton
 * Coin viewer that is stable enough to ship as a default — DevNet at
 * `devnet.ccview.io`, MainNet at `canton.ccview.io`. Operators who
 * prefer their own Splice scan instance (e.g. an in-house validator
 * scan) can override per network via
 * `NEXT_PUBLIC_CANTON_EXPLORER_BASE_<NETWORK>`. `local` stays `null`
 * because the localnet has no public scan to send the link to.
 */
const DEFAULT_BASE_BY_NETWORK: Record<string, string | null> = Object.freeze({
  mainnet: 'https://ccview.io',
  devnet: 'https://devnet.ccview.io',
  local: null,
});

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function readEnvBase(network: string): string | null {
  const key = `NEXT_PUBLIC_CANTON_EXPLORER_BASE_${network.toUpperCase()}`;
  const fromEnv = process.env[key];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return trimTrailingSlash(fromEnv);
  }
  const fallback = DEFAULT_BASE_BY_NETWORK[network.toLowerCase()];
  return fallback === null || fallback === undefined ? null : trimTrailingSlash(fallback);
}

/**
 * Build the Canton Explorer URL for a transaction (update) id on a
 * given network, or `null` when no explorer is configured for that
 * network.
 *
 * URL shape (`<base>/transfers/<update_id>/`) matches ccview.io's
 * deep-link path. Canton update ids are `1220<hex>:<index>` —
 * the colon is a valid URL-path char and ccview's own examples
 * leave it un-encoded, so we pass it through as-is rather than
 * URL-encoding (encodeURIComponent would turn `:` into `%3A` and
 * break the link). If a private deployment uses a different shape,
 * expose a second helper rather than adding a branch here.
 */
export function cantonExplorerTransferUrl(
  updateId: string | null | undefined,
  network: string | null | undefined,
): string | null {
  if (typeof updateId !== 'string' || updateId.length === 0) return null;
  if (typeof network !== 'string' || network.length === 0) return null;
  const base = readEnvBase(network);
  if (base === null) return null;
  return `${base}/transfers/${updateId}/`;
}

/**
 * Truncate a long Canton id (contract id or update id) for display.
 * Keeps the first eight and last six hex characters with an ellipsis
 * in the middle — enough to recognise a familiar id without the row
 * wrapping.
 */
export function truncateContractId(contractId: string, head = 8, tail = 6): string {
  if (contractId.length <= head + tail + 1) return contractId;
  return `${contractId.slice(0, head)}…${contractId.slice(-tail)}`;
}
