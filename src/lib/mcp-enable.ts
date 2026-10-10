/**
 * mcp-enable.ts — flair#719: `flair mcp enable/disable/status`, the last
 * piece of the paved-paths command family. Automates the operator checklist
 * documented in docs/notes/mcp-oauth-model2.md into one command.
 *
 * ── flair#756 (2026-07-19): CIMD-only, DCR removed entirely ──────────────────
 * #754 shipped `enable`'s default flow pre-registering claude.ai via DCR
 * (RFC 7591 Dynamic Client Registration) + provisioning a DCR gate token.
 * That contradicted the strategic direction (Nathan, on the record,
 * 2026-07-19): CIMD-only looking forward, DCR is not the path — and the
 * scope was amended same-day from "CIMD-first with a --with-dcr legacy
 * hatch" to full removal: DCR is UNSUPPORTED on this surface, not legacy.
 * There is no `--with-dcr` flag, no gate-token machinery, and
 * `src/lib/dcr-client.ts` (the module that used to own the gate-token
 * contract + the RFC 7591 HTTP client) is deleted.
 *
 * Ground truth (verified in installed @harperfast/oauth@2.2.0 source): the
 * plugin fully supports CIMD for the interactive authorization_code flow —
 * `authorize.js` resolves URL-shaped client_ids via `cimd.js`'s
 * `resolveClient` (metadata-document fetch, rate-limited,
 * `clientIdMetadataDocuments.allowedHosts` gate, redirect-URI-host
 * validation baked into the fetched document itself). A CIMD-capable client
 * like claude.ai needs ZERO pre-registration — there is no client_id for
 * `enable` to hand back, because Claude presents its OWN CIMD document URL
 * as its client_id (Anthropic docs: claude.com/docs/connectors/building/
 * authentication — "Claude uses an HTTPS URL as its client_id, and your
 * authorization server fetches the metadata document from that URL").
 *
 * **Leaving `dynamicClientRegistration` unset does NOT disable DCR** — this
 * is the load-bearing ground-truth fact this rewrite is built on. Read
 * directly from the installed package:
 *   - `node_modules/@harperfast/oauth/dist/types.d.ts:131-144` (the
 *     `MCPDynamicClientRegistrationConfig` doc comment): "Defaults to
 *     enabled because Claude Desktop, Cursor, and mcp-remote all register at
 *     runtime with no pre-baked client_id. Restricting registration is
 *     opt-in via initialAccessToken or allowedRedirectUriHosts."
 *   - `node_modules/@harperfast/oauth/dist/lib/mcp/dcr.js:161-167`
 *     (`handleRegister`): `if (dcrConfig?.enabled === false) return 404`.
 *     An ABSENT `dynamicClientRegistration` block leaves `dcrConfig`
 *     `undefined`, so `dcrConfig?.enabled === false` is `false` — the
 *     endpoint stays live.
 *   - `dcr.js:16-24` (`checkInitialAccessToken`): "Returns null when no
 *     token is configured (open registration per RFC 7591)." — an absent
 *     `initialAccessToken` means the endpoint accepts ANY registration,
 *     unauthenticated.
 *   So simply never writing the block would leave `/oauth/mcp/register`
 *   OPEN, not inert — the opposite of "DCR removed." `buildMcpOAuthConfigBlock`
 *   below therefore writes an EXPLICIT `dynamicClientRegistration: { enabled:
 *   false }` — the one config shape that is verifiably fail-closed
 *   (dcr.js:165-167's 404 branch) — and never writes `initialAccessToken` or
 *   `allowedRedirectUriHosts` (there is no gate-token machinery to configure
 *   them with). A structural test in test/unit/mcp-enable.test.ts asserts
 *   this shape directly.
 *
 * ── K&S conditions from #719, still honored ──────────────────────────────────
 *   - Sherlock: `accessTokenTtl` is explicitly 900 in the written config
 *     block, never left at the plugin's 1h default (see
 *     `buildMcpOAuthConfigBlock`).
 *   - Sherlock (the #741 lesson): self-verification is the exit criterion.
 *     On failure, the result names which step to re-run — never reports
 *     success on hope (see `EnableMcpResult.failedStep`). flair#756 extends
 *     this: self-verify now also confirms the metadata endpoint advertises
 *     CIMD support (the exact pair Claude's client checks — see
 *     `selfVerifyMcpMetadata` below), not just that the endpoint answers.
 *   - Secrets provisioning is shape-aware but never silent: every result
 *     names the mechanism chosen and where the material lives (paths only —
 *     values never appear in `EnableMcpResult` or on stdout).
 *
 * ── Ground truth used to design the remote "existing ops paths" step ────────
 * Verified against the ACTUALLY INSTALLED packages, not assumed:
 *   - `harper`'s Operations API has a genuine `set_configuration`
 *     operation (writes harperdb-config.yaml for all workers, requires a
 *     restart to take effect — node_modules/harper/dist/config/
 *     configUtils.js's `setConfiguration`) and a genuine `restart` operation
 *     (whole-process restart — see .../components/mcp/tools/schemas/
 *     operationDescriptions.js's operation catalog). Both are called the
 *     SAME way `grantMcpClient`/`revokeMcpClient` (src/cli.ts) already call
 *     the ops API: Basic admin auth, POST a JSON operation body, targeting
 *     either a local port or a remote URL — genuinely "the existing remote
 *     ops paths" the design addendum names, not a new mechanism invented for
 *     this slice.
 *   - `FLAIR_MCP_OAUTH` (resources/mcp-oauth-flag.ts) is read from
 *     `process.env` ONLY — never YAML config — so it (and the OAuth secrets —
 *     the IdP client secret) cannot be set via
 *     `set_configuration`. Those are delivered through the shape-aware
 *     secrets-provisioning step below (a 0600 staging file the operator
 *     applies via Fabric Studio's environment panel, or their own
 *     process-manager env). `enable` requires the operator to confirm
 *     application (`confirmSecretsApplied`, or an interactive prompt) before
 *     it calls `restart` — otherwise the restart would just bounce back to
 *     the flag-OFF byte-identical boot with the new config.yaml block inert.
 *   - `@harperfast/oauth`'s config field names (`mcp.issuer`, `mcp.resource`,
 *     `mcp.accessTokenTtl`, `mcp.dynamicClientRegistration.enabled`,
 *     `mcp.clientIdMetadataDocuments.allowedHosts`) are
 *     confirmed against the installed 2.2.0 package's source
 *     (dist/types.d.ts:38-229, dist/lib/mcp/{dcr,cimd,keyStore,token}.js).
 *   - The self-verification target, `${issuer}/.well-known/oauth-
 *     authorization-server` (RFC 8414), is served by
 *     `dist/lib/mcp/wellKnown.js`'s `buildAuthorizationServerMetadata`
 *     (lines 129-166), which advertises `registration_endpoint`/
 *     `token_endpoint` unconditionally (NOTE: `registration_endpoint` is
 *     advertised even though DCR is disabled — CORRECTED 2026-08-05: that was
 *     true of the version this was written against and is FALSE of the
 *     installed one. wellKnown.js:142 now reads
 *     `...(dcrEnabled(mcpConfig) ? { registration_endpoint: … } : {})`, so the
 *     field is OMITTED whenever DCR is off — which is every instance `enable`
 *     configures. selfVerifyMcpMetadata required it and therefore failed on a
 *     correctly enabled surface; see the note at that check. A verified fact
 *     carries the date it was verified, and this one expired.) and
 *     `client_id_metadata_document_supported: true` whenever
 *     `clientIdMetadataDocuments.enabled !== false` (wellKnown.js:164 — true
 *     by default, which is what our config relies on), and
 *     `token_endpoint_auth_methods_supported` always includes `"none"`
 *     (wellKnown.js:148-149) — together the exact pair Anthropic's docs say
 *     Claude checks before it will use CIMD instead of DCR (claude.com/docs/
 *     connectors/building/authentication: "Claude selects CIMD only when
 *     your authorization server metadata advertises both
 *     client_id_metadata_document_supported: true and none in
 *     token_endpoint_auth_methods_supported").
 *   - The GitHub OAuth-app callback URL, `${issuer}/oauth/github/callback`,
 *     is the plugin's own README "Configure OAuth Callback" convention
 *     (`https://your-domain/oauth/<provider>/callback`).
 *   - The claude.ai CIMD/redirect-URI allowlist hosts: Anthropic's current
 *     docs (claude.com/docs/connectors/building/authentication, "Callback
 *     URLs" — fetched 2026-07-19) name `https://claude.ai/api/mcp/
 *     auth_callback` as the redirect URI for the hosted Claude surfaces
 *     (Claude.ai web, Desktop, mobile, Cowork), and the lazy-authentication
 *     doc's CIMD section notes "the listed redirect_uris should be required
 *     to be same-origin with the client_id URL" — so claude.ai is the
 *     confirmed CIMD client_id host for that surface. `claude.com` is kept
 *     alongside it because it's this repo's own pre-existing allowlist value
 *     (`resources/OAuth.ts:24`'s `ALLOWED_REDIRECT_URI` for the 1.0
 *     opaque-token AS, and this module's own prior `DEFAULT_REDIRECT_URI_HOSTS`
 *     constant) — carried forward defensively, not newly invented; CIMD
 *     `allowedHosts` only widens which hosts MAY present a client_id URL,
 *     every resolution still runs the full SSRF/document-validation pipeline
 *     in `cimd.js`, so listing an extra host is not a meaningful risk
 *     expansion.
 */

import { isLoopbackUrl } from "../component-env.js";
import { probeSecretsCapability, pushSecrets, PROCESS_ENV_TIER } from "./secrets-push.js";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, realpathSync } from "node:fs";
import { hostname as osHostname } from "node:os";

import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import { resolveHome } from "./home.js";
import { writeConfirmed } from "./instance-identity-row.js";
import { invalidAgentIdMessage, isValidAgentId } from "./agent-id-rule.js";
import { agentHomeEndpoint, resolveTargetInstanceId } from "./agent-home.js";
import { defaultReadProcessCmdline, defaultReadProcessCwd } from "./upgrade-exec-path.js";

// ─── CIMD constants ──────────────────────────────────────────────────────────

/** Default `clientIdMetadataDocuments.allowedHosts` allowlist — see the
 *  module header's "claude.ai CIMD/redirect-URI allowlist hosts" note for
 *  the citation trail. Schema: node_modules/@harperfast/oauth/dist/
 *  types.d.ts:211-229 (`MCPClientIdMetadataDocumentsConfig.allowedHosts`). */
export const DEFAULT_CIMD_ALLOWED_HOSTS = ["claude.ai", "claude.com"];

/** Required TTL per Sherlock's Model-2 requirement 1 — never the plugin's 1h default. */
export const REQUIRED_ACCESS_TOKEN_TTL = 900;

// ─── Local-origin detection (scenario addendum, binding) ───────────────────

function isLocalIpv4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isLocalOrigin(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local")) return true;
  if (hostname.startsWith("[")) {
    if (hostname === "[::]" || hostname === "[::1]") return true;
    const first = parseInt(hostname.slice(1).split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
    const mapped = hostname.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      return isLocalIpv4(high >>> 8, high & 0xff);
    }
    return false;
  }
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return ipv4 !== null && isLocalIpv4(Number(ipv4[1]), Number(ipv4[2]));
}

export function checkLocalOriginRefusal(url: string):
  { refused: true; reason: "invalid" | "local"; message: string } | { refused: false } {
  try {
    if (!new URL(url).hostname) throw new Error("missing host");
  } catch {
    return { refused: true, reason: "invalid", message: "Issuer refused: invalid URL." };
  }
  if (isLocalOrigin(url)) return {
    refused: true, reason: "local",
    message: "Issuer refused: local hostname or loopback, unspecified, reserved 0.0.0.0/8, private or link-local IP literal.",
  };
  return { refused: false };
}

export function issuerOriginRefusal(issuer: string): string | null {
  let valid = false;
  try {
    if (/^https?:\/\/[^/?#\\\s]+\/?$/.test(issuer)) {
      valid = issuer.replace(/\/$/, "") === new URL(issuer).origin;
    }
  } catch {
    valid = false;
  }
  if (valid) return null;
  return (
    `--issuer must be an absolute http(s) origin with no path (got: ${JSON.stringify(issuer)}); ` +
    `set it to the instance's public origin, e.g. https://flair.example.com. Nothing was changed.`
  );
}

/**
 * flair#2115 — the target policy for `flair principal link|unlink|links`.
 *
 * These commands send the target instance's admin credential to its operations
 * API. HTTPS is required, and an unparseable URL and the literal host classes
 * `isLocalOrPrivateHost` lists are refused.
 *
 * Refusals are only ADDED relative to `checkLocalOriginRefusal`: everything
 * that check refuses, this one refuses too.
 */
export function checkMappingTargetRefusal(url: string): { refused: true; message: string } | { refused: false } {
  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    return { refused: true, message: mappingTargetRefusalMessage(url) };
  }
  if (protocol !== "https:" || host === "") return { refused: true, message: mappingTargetRefusalMessage(url) };
  if (isLocalOrPrivateHost(host)) return { refused: true, message: mappingTargetRefusalMessage(url) };
  return { refused: false };
}

/** The one sentence a refused target gets, whichever way it failed that test. */
function mappingTargetRefusalMessage(url: string): string {
  return (
    "these commands send the target instance's admin credential to its operations API, so --instance must be an " +
    "HTTPS URL whose host is not localhost, a .local name, or a loopback, unspecified, RFC1918, link-local or " +
    `IPv6 unique-local address literal; '${url}' is refused. See the hosted-shape docs.`
  );
}

/** Is `hostname` (as `URL.hostname` gives it) localhost, a .local name, or a
 *  loopback, unspecified, RFC1918, link-local or IPv6 unique-local literal?
 *  IPv6 literals stay bracketed in `URL.hostname`; a trailing dot is the
 *  absolute form of the same name. */
function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.startsWith("[") && host.endsWith("]")) return isLocalOrPrivateIpv6(host.slice(1, -1));
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return isLocalOrPrivateIpv4(ipv4.slice(1).map((part) => Number(part)));
  return false;
}

function isLocalOrPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isLocalOrPrivateIpv6(literal: string): boolean {
  const addr = literal.toLowerCase();
  // An IPv4-mapped address carries an IPv4 address in its low 32 bits; WHATWG
  // URL normalises the dotted form to two hex groups ("::ffff:c0a8:1").
  const mapped = addr.match(/^::ffff:([0-9a-f:.]+)$/);
  if (mapped) {
    const tail = mapped[1];
    const dotted = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) return isLocalOrPrivateIpv4(dotted.slice(1).map((part) => Number(part)));
    const groups = tail.split(":");
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0] || "0", 16);
      const lo = Number.parseInt(groups[1] || "0", 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return isLocalOrPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
      }
    }
    return true; // an IPv4-mapped form this cannot read is not a public origin
  }
  if (addr === "::" || addr === "::1") return true; // unspecified, loopback
  const first = Number.parseInt(addr.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  return false;
}

// ─── Fabric-shape detection (secrets-mechanism default) ────────────────────

export function isFabricOrigin(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".harperfabric.com");
  } catch {
    return false;
  }
}

export function isFabricTarget(instanceUrl: string, fabric = false): boolean {
  return fabric === true || isFabricOrigin(instanceUrl);
}

export function fabricLoopbackRefusal(instanceUrl: string, fabric = false): string | undefined {
  if (fabric && isLoopbackUrl(instanceUrl)) return "--fabric cannot be used with a loopback or unspecified target. Remove --fabric.";
}

export type SecretsMechanism = "fabric-env-secrets" | "env-file";

export function selectSecretsMechanism(instanceUrl: string, override?: SecretsMechanism, fabric = false): SecretsMechanism {
  if (override) return override;
  return isFabricTarget(instanceUrl, fabric) ? "fabric-env-secrets" : "env-file";
}

// ─── --cimd-allowed-hosts (flair#2113) ───────────────────────────────────────
//
// The component reads `mcp.clientIdMetadataDocuments.allowedHosts` from the
// `@harperfast/oauth` block of the component config.yaml. A whole-token `${VAR}`
// there can carry ONE host, but not a comma-separated list, and it cannot keep
// the default when unset. Measured on the installed @harperfast/oauth 2.5.0
// (dist/lib/config.js, `expandEnvVar` + `normalizeMcpSecurityConfig`): the
// variable's value becomes a one-entry list and is never split on commas; an
// unset variable leaves the literal placeholder as the only entry, so the
// claude.ai + claude.com default stops applying; and an empty value becomes
// `[]`, for which dist/lib/mcp/cimd.js skips its allowedHosts gate.
//
// So `enable` ensures a literal list in a config.yaml on THIS machine (the
// file it already edits for mcp.enabled), after the preflight match in
// `checkTargetRunsFromConfig`. It refuses a Fabric origin and, outside
// --dry-run, a failed match. --dry-run skips the match and never writes the list.

/** The config key the flag sets, as operator messages name it. */
export const CIMD_ALLOWED_HOSTS_CONFIG_KEY = "mcp.clientIdMetadataDocuments.allowedHosts";

/** A `--cimd-allowed-hosts` value that is not a list of lowercase bare hostnames. */
export class CimdAllowedHostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CimdAllowedHostsError";
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate `--cimd-allowed-hosts` entries: lowercase bare hostnames only.
 * Throws `CimdAllowedHostsError` for an empty list, or for the first bad entry
 * (named, 1-based). Spaces around an entry are trimmed; nothing else is
 * rewritten: an uppercase entry is refused, not lowercased.
 */
export function validateCimdAllowedHosts(entries: readonly string[]): string[] {
  const flag = "--cimd-allowed-hosts";
  if (entries.length === 0 || (entries.length === 1 && String(entries[0]).trim() === "")) {
    throw new CimdAllowedHostsError(
      `${flag}: no hostnames given. Pass one or more lowercase hostnames, comma-separated (for example claude.ai,claude.com).`,
    );
  }
  const hosts: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const host = String(entries[i]).trim();
    const refuse = (why: string): never => {
      throw new CimdAllowedHostsError(`${flag} entry ${i + 1} ${why}`);
    };
    if (host === "") refuse("is empty. Remove the extra comma, or pass a hostname.");
    const shown = JSON.stringify(host);
    if (host.includes("*")) refuse(`(${shown}) is a wildcard. List each hostname exactly.`);
    if (host.includes("/")) refuse(`(${shown}) is a URL or path. Pass the bare hostname only.`);
    if (host.startsWith("[") || host.split(":").length > 2) refuse(`(${shown}) looks like an IPv6 address. Pass a hostname.`);
    if (host.includes(":")) refuse(`(${shown}) contains ":" (a port or scheme). Pass the bare hostname only.`);
    if (host !== host.toLowerCase()) refuse(`(${shown}) has uppercase letters. Hostnames must be lowercase.`);
    const labels = host.split(".");
    if (host.length > 253 || !labels.every((label) => HOSTNAME_LABEL.test(label))) {
      refuse(
        `(${shown}) is not a valid hostname: dot-separated labels of a-z, 0-9 and inner hyphens, ` +
          `each 1-63 characters, 253 in all at most.`,
      );
    }
    if (/^[0-9]+$/.test(labels[labels.length - 1])) refuse(`(${shown}) ends in a numeric label, as an IP address does. Pass a hostname.`);
    if (hosts.includes(host)) refuse(`(${shown}) repeats an earlier entry.`);
    hosts.push(host);
  }
  return hosts;
}

export function cimdAllowedHostsShapeRefusal(instanceUrl: string, fabric = false): string | null {
  if (!isFabricTarget(instanceUrl, fabric)) return null;
  return (
    `--cimd-allowed-hosts is refused for a Fabric instance (${new URL(instanceUrl).hostname}): ` +
    `the component reads ${CIMD_ALLOWED_HOSTS_CONFIG_KEY} from the @harperfast/oauth block of the config.yaml ` +
    `deployed with it, and this command does not write that file. ` +
    `Set the key in the config.yaml you deploy, then redeploy. Nothing was changed.`
  );
}

/**
 * The CLI's reading of `--cimd-allowed-hosts`: `{}` when the flag is absent,
 * `{ hosts }` when it is valid for this target, `{ error }` otherwise. An
 * explicit empty value is an error, never "absent".
 */
export function cimdAllowedHostsFromFlag(raw: unknown, instanceUrl: string, fabric = false): { hosts?: string[]; error?: string } {
  if (raw === undefined) return {};
  let hosts: string[];
  try {
    hosts = validateCimdAllowedHosts(String(raw).split(","));
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
  const refusal = cimdAllowedHostsShapeRefusal(instanceUrl, fabric);
  return refusal ? { error: refusal } : { hosts };
}

/**
 * The note a successful `enable` prints when the list this run confirmed
 * leaves claude.ai out. `enable` ensures the requested list in config.yaml
 * (it writes the list only when the file does not already hold that exact
 * list) and reads it back; the argument is that read-back list.
 * dist/lib/mcp/cimd.js treats a client_id URL whose host is not on a non-empty
 * allowedHosts as an unknown client. Null when this run confirmed no list, or
 * one with claude.ai.
 */
export function claudeAiExcludedNote(written: readonly string[] | undefined): string | null {
  if (!written || written.includes("claude.ai")) return null;
  return (
    `claude.ai is not in the ${CIMD_ALLOWED_HOSTS_CONFIG_KEY} list this run ensured and read back (${JSON.stringify(written)}), ` +
    `so while the instance uses that list, a CIMD client_id URL on claude.ai is refused. ` +
    `Re-run with claude.ai in --cimd-allowed-hosts to allow it.`
  );
}

// ─── @harperfast/oauth config block ──────────────────────────────────────────

export interface McpOAuthConfigBlockParams {
  idpProvider: string;
  /** `clientIdMetadataDocuments.allowedHosts` override — defaults to
   *  `DEFAULT_CIMD_ALLOWED_HOSTS`. */
  cimdAllowedHosts?: string[];
  // flair#1152: no `enabled` param. mcp.enabled is ALWAYS emitted as the
  // whole-token env reference ${FLAIR_MCP_OAUTH} — the on/off choice lives in
  // the instance environment, never in the generated file, so a re-packed
  // deploy cannot revert it. A param here would reintroduce the literal.
}

/**
 * The `@harperfast/oauth` config block, matching the installed 2.2.0
 * package's field names (node_modules/@harperfast/oauth/dist/types.d.ts).
 * Secrets are `${ENV_VAR}` placeholders — never literal values.
 *
 * flair#1136: set_configuration delivery was removed. Fabric regenerates
 * the root harperdb-config.yaml; the component's own config.yaml is the
 * source of truth for the oauth block. This function builds the block that
 * ships in config.yaml — it is never written to harperdb-config.yaml.
 *
 * flair#756: `dynamicClientRegistration: { enabled: false }` is written
 * EXPLICITLY — never omitted. See the module header's "Leaving
 * `dynamicClientRegistration` unset does NOT disable DCR" note: an absent
 * block leaves the plugin's own default (OPEN, ungated registration) live
 * (dcr.js:161-167, types.d.ts:131-144). `enabled: false` is the one shape
 * that actually 404s the endpoint (dcr.js:165-167). No `initialAccessToken`
 * / `allowedRedirectUriHosts` are ever written — there is no gate-token
 * machinery left to populate them with.
 */
export function buildMcpOAuthConfigBlock(params: McpOAuthConfigBlockParams): Record<string, unknown> {
  const provider = params.idpProvider;
  const envPrefix = `OAUTH_${provider.toUpperCase()}`;
  const cimdAllowedHosts = params.cimdAllowedHosts ?? DEFAULT_CIMD_ALLOWED_HOSTS;
  return {
    "@harperfast/oauth": {
      package: "@harperfast/oauth",
      providers: {
        [provider]: {
          clientId: `\${${envPrefix}_CLIENT_ID}`,
          clientSecret: `\${${envPrefix}_CLIENT_SECRET}`,
          // Since @harperfast/oauth 2.7.0 a CONFIGURED provider (both
          // credentials set) needs a redirectUri; 2.8.1 skips an UNCONFIGURED
          // one before that check (HarperFast/oauth#259). Same whole-token
          // reference shape as the credentials above — set to the instance's
          // public origin plus /oauth; the component appends '/<provider>/callback'.
          redirectUri: `\${${envPrefix}_REDIRECT_URI}`,
        },
      },
      mcp: {
        // flair#1152: whole-token env reference — same flag flair's in-process
        // route gates on. ASYMMETRY (load-bearing, measured on oauth 2.5.0):
        // the component's coerceConfigBoolean accepts ONLY "true"/"false" and
        // DELETES any other string (unresolved placeholder, "1", "yes",
        // garbage) so its disabled default applies; flair's mcpOAuthEnabled()
        // (resources/mcp-oauth-flag.ts) accepts 1/true/yes/on. So "true" is
        // the one value that enables BOTH; "1"/"yes"/"on" flip flair's /mcp
        // handler on while the component AS stays off (fail-closed broken-on:
        // all 401, no AS advertised); garbage/unset disable both. On oauth
        // <2.5.0 there is NO normalization and an unresolved placeholder is a
        // truthy string (fail-open) — which is why the resolved-version
        // assertion in mcp-oauth-boot-safety.test.ts exists. If component
        // `enabled` semantics ever change, or it ever drives flair handler
        // registration directly, re-derive this table before shipping.
        enabled: "${FLAIR_MCP_OAUTH}",
        issuer: "${FLAIR_MCP_ISSUER}",
        // flair#1180: NO `resource` key — the component's resolveResource()
        // derives `<issuer>/mcp` at request time when it is absent, identical
        // to flair's in-process derivation. The old composite
        // "${FLAIR_MCP_ISSUER}/mcp" never interpolated (whole-token-only
        // expansion) and failed every connect with invalid_target. Escape
        // hatch: an operator needing a non-standard resource sets an explicit
        // LITERAL absolute URL in config.yaml (never a composite).
        accessTokenTtl: REQUIRED_ACCESS_TOKEN_TTL,
        // Explicit fail-closed disable — see the doc comment above and the
        // module header for why an omitted block is NOT equivalent to this.
        dynamicClientRegistration: { enabled: false },
        // CIMD is the only supported client-registration path. `allowedHosts`
        // restricts which hosts may present a CIMD client_id URL — schema at
        // node_modules/@harperfast/oauth/dist/types.d.ts:211-229. Every
        // resolution still runs cimd.js's full SSRF/document-validation
        // pipeline regardless of this list.
        clientIdMetadataDocuments: { allowedHosts: cimdAllowedHosts },
        // Without signingKeyPem, minting reuses a persisted key or generates
        // and persists one if oauth.harper_oauth_mcp_keys is empty.
      },
    },
  };
}

// ─── Local config.yaml update (flair#1136) ──────────────────────────────────

/** The whole-token env reference `flair mcp enable` writes as mcp.enabled
 *  (flair#1152). The on/off choice lives in the environment (the secrets
 *  bundle stages FLAIR_MCP_OAUTH=true — see buildSecretsBundle for why it
 *  must be "true"), never as a literal in the config file. */
export const MCP_ENABLED_ENV_REFERENCE = "${FLAIR_MCP_OAUTH}";

/**
 * The local component config.yaml `enable` edits: `explicitPath` alone when
 * given, otherwise `./config.yaml`, then `~/.flair/config.yaml` — the first
 * that exists. Shared by `updateLocalConfigMcpEnabled` and the flair#2113
 * allowedHosts writer so both edit the same file.
 */
function resolveLocalConfigPath(explicitPath?: string): { configPath: string | null; candidates: string[] } {
  const candidates = explicitPath
    ? [explicitPath]
    : ["config.yaml", join(resolveHome(), ".flair", "config.yaml")];
  return { configPath: candidates.find((p) => existsSync(p)) ?? null, candidates };
}

/**
 * Set mcp.enabled in a local component config.yaml to the flair#1152 shape.
 * Best-effort: returns `{ ok: false }` with a reason when the file can't be
 * found or parsed.
 *
 * `enabled: true` writes the WHOLE-TOKEN env reference ${FLAIR_MCP_OAUTH}
 * (never a literal `true` — the env var, staged to `true` by the secrets bundle,
 * carries the choice; a legacy literal `true` found in the file is normalized
 * to the reference). `enabled: false` writes literal `false` — decisively off
 * regardless of environment.
 *
 * Uses `explicitPath` alone if given; otherwise `./config.yaml`, then `~/.flair/config.yaml`.
 */
export function updateLocalConfigMcpEnabled(
  enabled: boolean,
  explicitPath?: string,
): { ok: boolean; detail: string } {
  const { configPath, candidates } = resolveLocalConfigPath(explicitPath);

  // The value the file should carry for this call (flair#1152): the env
  // reference when enabling, literal false when disabling.
  const target: string | boolean = enabled ? MCP_ENABLED_ENV_REFERENCE : false;
  const targetLabel = enabled ? `${MCP_ENABLED_ENV_REFERENCE} (env-referenced)` : "false";

  if (!configPath) {
    return {
      ok: false,
      detail: `local config.yaml not found (tried: ${candidates.join(", ")}). ` +
        (enabled
          ? explicitPath
            ? `Place your component config.yaml at ${explicitPath}, then re-run with the same explicit path.`
            : `Re-run \`flair mcp enable\` from the directory that holds your component config.yaml (or place it at ${candidates[1]}).`
          : `Set mcp.enabled: ${targetLabel} in your component config.yaml manually, then restart.`),
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err: any) {
    return { ok: false, detail: `cannot read ${configPath}: ${err.message}` };
  }

  // Parse the YAML to navigate to the exact key — avoids the ambiguity of
  // string-matching `enabled:` when the block has multiple enabled keys
  // (mcp.enabled vs dynamicClientRegistration.enabled).
  let doc: any;
  try {
    doc = yaml.load(raw);
  } catch (err: any) {
    return { ok: false, detail: `cannot parse ${configPath} as YAML: ${err.message}` };
  }

  if (!doc || typeof doc !== "object") {
    return { ok: false, detail: `${configPath} is empty or not a YAML mapping` };
  }

  const oauth = doc["@harperfast/oauth"];
  if (!oauth || typeof oauth !== "object") {
    return {
      ok: false,
      detail: `@harperfast/oauth block not found in ${configPath}. ` +
        `Ensure the component block is present with mcp.enabled: ${targetLabel}.`,
    };
  }

  const mcp = oauth.mcp;
  if (!mcp || typeof mcp !== "object") {
    return {
      ok: false,
      detail: `mcp key not found under @harperfast/oauth in ${configPath}. ` +
        `Ensure the mcp block is present with enabled: ${targetLabel}.`,
    };
  }

  const current = mcp.enabled;
  if (current === target) {
    return { ok: true, detail: `mcp.enabled already ${targetLabel} in ${configPath}` };
  }

  // Mutate the parsed document and re-emit.
  mcp.enabled = target;

  const updated = yaml.dump(doc, { lineWidth: -1, noCompatMode: true });
  try {
    writeFileSync(configPath, updated, { encoding: "utf-8" });
  } catch (err: any) {
    return { ok: false, detail: `cannot write ${configPath}: ${err.message}` };
  }

  return { ok: true, detail: `mcp.enabled set to ${targetLabel} in ${configPath}` };
}

// ─── Local config.yaml: clientIdMetadataDocuments.allowedHosts (flair#2113) ──

type ReadConfigFile = (path: string) => string;
type WriteConfigFile = (path: string, data: string) => void;

const readConfigFile: ReadConfigFile = (path) => readFileSync(path, "utf-8");
const writeConfigFile: WriteConfigFile = (path, data) => writeFileSync(path, data, { encoding: "utf-8" });

/** Flat rather than a discriminated union: tsconfig.cli.json (strict: false)
 *  does not narrow on `ok`. `raw`/`doc`/`mcp` are meaningful only when `ok`. */
interface LoadedOauthMcp {
  ok: boolean;
  detail: string;
  raw?: string;
  doc?: any;
  mcp?: any;
}

/** Parse `path` and reach its `@harperfast/oauth` → `mcp` mapping. Every failure is a named `ok: false`. */
function loadOauthMcpBlock(path: string, readFile: ReadConfigFile): LoadedOauthMcp {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (err: any) {
    return { ok: false, detail: `cannot read ${path}: ${err?.message ?? err}` };
  }
  let doc: any;
  try {
    doc = yaml.load(raw);
  } catch (err: any) {
    return { ok: false, detail: `cannot parse ${path} as YAML: ${err?.message ?? err}` };
  }
  const isMapping = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  const mcp = isMapping(doc) && isMapping(doc["@harperfast/oauth"]) ? doc["@harperfast/oauth"].mcp : undefined;
  if (!isMapping(mcp)) return { ok: false, detail: `${path} has no @harperfast/oauth block with an mcp mapping` };
  const cimd = mcp.clientIdMetadataDocuments;
  if (cimd !== undefined && cimd !== null && !isMapping(cimd)) {
    return { ok: false, detail: `${path}: mcp.clientIdMetadataDocuments is not a mapping` };
  }
  return { ok: true, detail: `${path} parsed`, raw, doc, mcp };
}

function sameHostList(value: unknown, hosts: readonly string[]): boolean {
  return Array.isArray(value) && value.length === hosts.length && value.every((h, i) => h === hosts[i]);
}

export interface LocalCimdAllowedHostsRead {
  ok: boolean;
  detail: string;
  path?: string;
  /** The value the file carries now (`undefined` when the key is absent). */
  current?: unknown;
}

/**
 * Read-only: which config.yaml would `updateLocalConfigCimdAllowedHosts` write,
 * and what list does it carry now? Same file resolution as
 * `updateLocalConfigMcpEnabled`. `enable` runs this before any step with a
 * side effect, so a file that is missing, unreadable or not valid YAML, or that
 * has no `@harperfast/oauth` → `mcp` mapping, refuses the flag up front. It
 * does not check that the file can be written: a write failure fails the later
 * `local-config-update` step.
 */
export function readLocalConfigCimdAllowedHosts(
  explicitPath?: string,
  deps: { readFile?: ReadConfigFile } = {},
): LocalCimdAllowedHostsRead {
  const { configPath: found, candidates } = resolveLocalConfigPath(explicitPath);
  if (!found) return { ok: false, detail: `no config.yaml found (tried: ${candidates.join(", ")})` };
  const configPath = resolve(found);
  const loaded = loadOauthMcpBlock(configPath, deps.readFile ?? readConfigFile);
  if (!loaded.ok) return { ok: false, path: configPath, detail: loaded.detail };
  return {
    ok: true,
    path: configPath,
    current: loaded.mcp.clientIdMetadataDocuments?.allowedHosts,
    detail: `${configPath} carries ${CIMD_ALLOWED_HOSTS_CONFIG_KEY}: ${JSON.stringify(loaded.mcp.clientIdMetadataDocuments?.allowedHosts ?? null)}`,
  };
}

/**
 * The application directory a Harper `run` or `dev` command line names,
 * resolved against the process's working directory; null when the command
 * line has no `run`/`dev` token. With no directory argument Harper runs the
 * application in its working directory (harper's bin/harper.js: `dev` falls
 * through to `run`, whose folder argument is realpath'd from the cwd).
 */
export function harperAppDirFromCmdline(cmdline: string, cwd: string): string | null {
  const tokens = cmdline.split(/\0|\s+/).filter((t) => t.length > 0);
  const at = tokens.findIndex((t) => t === "run" || t === "dev");
  if (at === -1) return null;
  const arg = tokens[at + 1];
  return resolve(cwd, arg && !arg.startsWith("-") ? arg : ".");
}

export interface TargetConfigCheckDeps {
  fetchImpl?: typeof fetch;
  /** Working directory of a process on THIS machine, or null when unreadable. */
  readProcessCwd?: (pid: number) => string | null;
  /** Command line of a process on THIS machine, or null when unreadable. */
  readProcessCmdline?: (pid: number) => string | null;
  /** This machine's hostname. */
  localHostname?: () => string;
}

/**
 * flair#2113 review: the preflight match between the target and `configPath`.
 * All required:
 *   1. the target's ops API `system_information` reports this machine's
 *      hostname and a Harper core process id;
 *   2. that pid's working directory and command line can be read on this
 *      machine, and the command line names a `run`/`dev` application
 *      directory (`harperAppDirFromCmdline`);
 *   3. `config.yaml` in that application directory and `configPath` resolve
 *      to the same file (`realpath`).
 * A check that fails, or cannot be completed, gives `ok: false` with the
 * reason.
 */
export async function checkTargetRunsFromConfig(
  instance: string,
  adminUser: string,
  adminPass: string,
  configPath: string,
  deps: TargetConfigCheckDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readCwd = deps.readProcessCwd ?? defaultReadProcessCwd;
  const readCmdline = deps.readProcessCmdline ?? defaultReadProcessCmdline;
  const localHost = (deps.localHostname ?? osHostname)();
  const opsUrl = resolveOpsUrl(instance);

  let data: any;
  try {
    const res = await fetchImpl(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuthHeader(adminUser, adminPass) },
      body: JSON.stringify({ operation: "system_information", attributes: ["system", "harperdb_processes"] }),
    });
    if (!res.ok) {
      return { ok: false, detail: `the target's ops API at ${opsUrl} answered system_information with HTTP ${res.status}` };
    }
    data = await res.json();
  } catch (err: any) {
    return { ok: false, detail: `could not ask the target's ops API at ${opsUrl} for system_information: ${err?.message ?? err}` };
  }
  const targetHost = data?.system?.hostname;
  const pid = data?.harperdb_processes?.core?.[0]?.pid;
  if (typeof targetHost !== "string" || targetHost === "" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, detail: `the target's system_information did not report both its hostname and its Harper process id` };
  }
  if (targetHost.toLowerCase() !== localHost.toLowerCase()) {
    return { ok: false, detail: `the target reports host ${JSON.stringify(targetHost)}, and this machine is ${JSON.stringify(localHost)}` };
  }
  const cwd = readCwd(pid);
  if (!cwd) {
    return { ok: false, detail: `the target reports pid ${pid}, and that pid's working directory could not be read on this machine` };
  }
  const cmdline = readCmdline(pid);
  const appDir = cmdline ? harperAppDirFromCmdline(cmdline, cwd) : null;
  if (!appDir) {
    return {
      ok: false,
      detail: `the target reports pid ${pid}, which runs in ${cwd} on this machine, and its application directory could not be read from its command line`,
    };
  }
  let targetConfig: string;
  let editedConfig: string;
  try {
    targetConfig = realpathSync(join(appDir, "config.yaml"));
    editedConfig = realpathSync(configPath);
  } catch (err: any) {
    return { ok: false, detail: `the target reports pid ${pid}, whose command line on this machine names application directory ${appDir}, and a config.yaml could not be resolved: ${err?.message ?? err}` };
  }
  if (targetConfig !== editedConfig) {
    return { ok: false, detail: `the target reports pid ${pid}, whose command line on this machine names application directory ${appDir}; its config.yaml is not ${editedConfig} by realpath` };
  }
  return {
    ok: true,
    detail: `preflight match: the target reports host ${targetHost} and pid ${pid}; that pid's command line on this machine names application directory ${appDir}, whose config.yaml is ${editedConfig} by realpath`,
  };
}

/**
 * Replace the value of `@harperfast/oauth` → `mcp` → `clientIdMetadataDocuments`
 * → `allowedHosts` in `raw` with a block sequence of `hosts`, touching no line
 * outside the list's own lines (comments between its items go with it).
 * Returns null when the key is absent, appears more than once, or has a value
 * this line scan does not handle (for example a flow sequence spanning lines);
 * the caller then re-emits the parsed document instead. The caller also
 * re-parses the result and compares it with the intended document before
 * using it.
 */
function replaceAllowedHostsLines(raw: string, hosts: readonly string[]): string | null {
  const path = ["@harperfast/oauth", "mcp", "clientIdMetadataDocuments", "allowedHosts"];
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(eol);
  const skippable = (line: string) => /^\s*(#.*)?$/.test(line);
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const keyLine = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s#'"\-][^:#]*?))\s*:(?:\s+(.*))?$/;

  const stack: { indent: number; key: string }[] = [];
  let at = -1;
  let atIndent = 0;
  let atRest = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skippable(line)) continue;
    const indent = indentOf(line);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const m = keyLine.exec(line);
    if (!m) continue;
    stack.push({ indent, key: m[1] ?? m[2] ?? m[3] });
    if (stack.length === path.length && stack.every((s, k) => s.key === path[k])) {
      if (at !== -1) return null;
      at = i;
      atIndent = indent;
      atRest = (m[4] ?? "").replace(/(^|\s+)#.*$/, "").trim();
    }
  }
  if (at === -1) return null;

  let end = at;
  if (atRest === "") {
    for (let j = at + 1; j < lines.length; j++) {
      const line = lines[j];
      if (skippable(line)) continue;
      const indent = indentOf(line);
      if (indent > atIndent || (indent === atIndent && line.trimStart().startsWith("-"))) {
        end = j;
        continue;
      }
      break;
    }
  } else if (atRest.startsWith("[") && !atRest.endsWith("]")) {
    return null;
  }
  const pad = " ".repeat(atIndent);
  const block = [`${pad}allowedHosts:`, ...hosts.map((h) => `${pad}  - ${JSON.stringify(h)}`)];
  return [...lines.slice(0, at), ...block, ...lines.slice(end + 1)].join(eol);
}

/**
 * Set `mcp.clientIdMetadataDocuments.allowedHosts` in the local component
 * config.yaml (same file resolution as `updateLocalConfigMcpEnabled`) to
 * `hosts`, then read the file back. `ok: true` only when the read-back equals
 * `hosts`; `readBack` is that read-back, never the intended value.
 *
 * The edit rewrites only the list's own lines when it can find them and the
 * result parses to the intended document, so comments outside the list
 * survive; otherwise it re-emits the parsed document, as
 * `updateLocalConfigMcpEnabled` does, and says so in `detail`.
 */
export function updateLocalConfigCimdAllowedHosts(
  hosts: readonly string[],
  explicitPath?: string,
  deps: { readFile?: ReadConfigFile; writeFile?: WriteConfigFile } = {},
): { ok: boolean; detail: string; path?: string; readBack?: string[] } {
  const readFile = deps.readFile ?? readConfigFile;
  const writeFile = deps.writeFile ?? writeConfigFile;
  let list: string[];
  try {
    list = validateCimdAllowedHosts(hosts);
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? String(err) };
  }
  const { configPath: found, candidates } = resolveLocalConfigPath(explicitPath);
  if (!found) return { ok: false, detail: `no config.yaml found (tried: ${candidates.join(", ")})` };
  const configPath = resolve(found);
  const loaded = loadOauthMcpBlock(configPath, readFile);
  if (!loaded.ok) return { ok: false, path: configPath, detail: loaded.detail };

  let how: string;
  let wrote = false;
  if (sameHostList(loaded.mcp.clientIdMetadataDocuments?.allowedHosts, list)) {
    how = "the file already held this list, so the allowed-hosts write was skipped";
  } else {
    const intended = structuredClone(loaded.doc);
    const mcp = intended["@harperfast/oauth"].mcp;
    mcp.clientIdMetadataDocuments = { ...(mcp.clientIdMetadataDocuments ?? {}), allowedHosts: [...list] };
    const edited = replaceAllowedHostsLines(loaded.raw ?? "", list);
    let text: string;
    if (edited !== null && JSON.stringify(safeYamlLoad(edited)) === JSON.stringify(intended)) {
      text = edited;
      how = "only the list's own lines were rewritten";
    } else {
      text = yaml.dump(intended, { lineWidth: -1, noCompatMode: true });
      how = "the file was re-emitted from its parsed form, so its comments were not kept";
    }
    try {
      writeFile(configPath, text);
    } catch (err: any) {
      return { ok: false, path: configPath, detail: `cannot write ${configPath}: ${err?.message ?? err}` };
    }
    wrote = true;
  }

  const back = loadOauthMcpBlock(configPath, readFile);
  if (!back.ok) {
    return {
      ok: false,
      path: configPath,
      detail: `${wrote ? `wrote ${configPath} but ` : ""}could not read it back: ${back.detail}`,
    };
  }
  const readBack = back.mcp.clientIdMetadataDocuments?.allowedHosts;
  if (!sameHostList(readBack, list)) {
    return {
      ok: false,
      path: configPath,
      detail: `${configPath} reads back ${CIMD_ALLOWED_HOSTS_CONFIG_KEY}: ${JSON.stringify(readBack ?? null)}, not ${JSON.stringify(list)}`,
    };
  }
  return {
    ok: true,
    path: configPath,
    readBack: [...readBack],
    detail: `${CIMD_ALLOWED_HOSTS_CONFIG_KEY} in ${configPath} reads back as ${JSON.stringify(readBack)} (${how})`,
  };
}

function safeYamlLoad(text: string): unknown {
  try {
    return yaml.load(text);
  } catch {
    return undefined;
  }
}

/** The exact callback URL to hand the operator when they create the IdP
 *  OAuth app ("with the exact GitHub callback URL printed"). */
export function idpCallbackUrl(issuer: string, idpProvider: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth/${idpProvider}/callback`;
}

// ─── Secrets bundle ──────────────────────────────────────────────────────────

export interface SecretsBundleParams {
  issuer: string;
  idpProvider: string;
  idpClientId: string;
  idpClientSecret: string;
}

export class IdpRedirectOriginError extends Error {
  constructor(envPrefix: string) {
    super(`Cannot stage ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET: ${envPrefix}_REDIRECT_URI requires a known HTTP(S) issuer origin.`);
    this.name = "IdpRedirectOriginError";
  }
}

/** The full set of env vars the restarted instance needs live. Contains
 *  secret VALUES — this is the one place they exist as a JS object; callers
 *  must never fold this into a CLI-printed / `EnableMcpResult` field. */
export function buildSecretsBundle(params: SecretsBundleParams): Record<string, string> {
  const envPrefix = `OAUTH_${params.idpProvider.toUpperCase()}`;
  let origin: string;
  try {
    const url = new URL(params.issuer);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new IdpRedirectOriginError(envPrefix);
    origin = url.origin;
  } catch {
    throw new IdpRedirectOriginError(envPrefix);
  }
  return {
    // "true" is the ONLY value both readers of this flag accept (flair#1152,
    // measured against oauth 2.5.0): flair's strict mcpOAuthEnabled() takes
    // 1/true/yes/on, but the component's coerceConfigBoolean takes ONLY
    // "true"/"false" and DELETES anything else (disabled default applies).
    // Staging "1" here would flip flair's /mcp handler ON while the
    // component's AS stays OFF — fail-closed but broken-on (every request
    // 401s, no AS is advertised). Keep this "true".
    FLAIR_MCP_OAUTH: "true",
    FLAIR_MCP_ISSUER: params.issuer.replace(/\/+$/, ""),
    [`${envPrefix}_CLIENT_ID`]: params.idpClientId,
    [`${envPrefix}_CLIENT_SECRET`]: params.idpClientSecret,
    [`${envPrefix}_REDIRECT_URI`]: `${origin}/oauth`,
  };
}

export function defaultSecretsStagingPath(issuer: string): string {
  let host = "instance";
  try {
    host = new URL(issuer).hostname;
  } catch {
    /* fall through to the generic name */
  }
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(resolveHome(), ".flair", `mcp-enable-secrets-${safe}.env`);
}

/** Write the secrets bundle to a 0600 staging file, `KEY=VALUE` per line.
 *  This file legitimately carries secret material (like `grant`'s 0600 key
 *  files) — the "never print secret values" rule is about stdout/returned
 *  result objects, not this deliberately-created, permission-locked file. */
export function writeSecretsStagingFile(path: string, bundle: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = Object.entries(bundle).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface SecretsProvisioningResult {
  mechanism: SecretsMechanism;
  path: string;
  varNames: string[];
  instructions: string;
}

/** Provision secrets per the shape-aware mechanism, staging the bundle to a
 *  0600 file and returning ONLY names/paths/instructions — never values. */
export function provisionSecrets(
  instanceUrl: string,
  bundle: Record<string, string>,
  opts: { mechanism?: SecretsMechanism; stagingPath?: string; fabric?: boolean } = {},
): SecretsProvisioningResult {
  const mechanism = selectSecretsMechanism(instanceUrl, opts.mechanism, opts.fabric);
  const path = opts.stagingPath ?? defaultSecretsStagingPath(instanceUrl);
  writeSecretsStagingFile(path, bundle);
  const varNames = Object.keys(bundle);

  const instructions =
    mechanism === "fabric-env-secrets"
      ? `Apply the ${varNames.length} vars staged at ${path} via Fabric Studio → Cluster Settings → Environment, then re-run with --confirm-secrets-applied.`
      : `Apply the ${varNames.length} vars staged at ${path} to the target instance's process environment (systemd/launchd unit, or your process manager), then re-run with --confirm-secrets-applied.`;

  return { mechanism, path, varNames, instructions };
}

// ─── Identity mapping (Credential kind:idp) ─────────────────────────────────

/**
 * The ops API is NOT the served origin, and its port is NOT derivable.
 *
 * flair#1072-adjacent, found while enabling MCP against a hosted instance: this
 * function used a string target verbatim, so `flair mcp enable --instance
 * https://flair.example.harperfabric.com` posted its ops calls to **port 443**,
 * where the flair REST component owns `/` and answers `404 Not found`. Measured
 * against a live Fabric instance, same request both ways:
 *
 *     POST https://<host>/          -> HTTP 404  "Not found"
 *     POST https://<host>:9925/     -> HTTP 200  []
 *
 * The codebase elsewhere documents "ops port = HTTP port - 1", which derives 442
 * for a 443-served instance. Also measured: 442 and 19925 are both dead on
 * Fabric. **That convention does not hold, and no arithmetic on the served port
 * can be trusted — an operator can put the ops API anywhere.**
 *
 * So: never derive silently. An explicit target wins; otherwise the conventional
 * hosted ops port is *tried*, and a caller that cannot reach it is told to pass
 * one rather than being handed a 404 about something else.
 */
export const HOSTED_OPS_PORT = 9925;

/** The served origin's host at HOSTED_OPS_PORT, or null when the origin does
 *  not parse. A bare host name is read as https. */
function hostedOpsUrl(servedOrigin: string): URL | null {
  try {
    const u = new URL(servedOrigin.includes("://") ? servedOrigin : `https://${servedOrigin}`);
    u.port = String(HOSTED_OPS_PORT);
    u.pathname = "/";
    u.search = "";
    return u;
  } catch {
    return null;
  }
}

export function resolveOpsUrl(target: number | string, explicitOpsUrl?: string): string {
  if (explicitOpsUrl) return `${explicitOpsUrl.replace(/\/+$/, "")}/`;
  if (typeof target === "number") return `http://127.0.0.1:${target}/`;
  // A string target is the SERVED origin. Its own port serves the REST surface,
  // not the ops API, so reuse the host and apply the hosted ops port.
  // Unparseable — preserve the old behaviour rather than inventing a URL, and
  // let the caller's error path name the remedy.
  return hostedOpsUrl(target)?.toString() ?? `${target.replace(/\/+$/, "")}/`;
}

function opsBaseUrl(opsPortOrUrl: number | string): string {
  return resolveOpsUrl(opsPortOrUrl);
}

function basicAuthHeader(adminUser: string, adminPass: string): string {
  return `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`;
}

/**
 * Where `provisionIdpIdentityMapping` sends its ops calls: exactly one of the
 * two fields (flair#2102).
 */
export type IdentityMappingOpsTarget =
  | {
      /**
       * The ops API itself. A number is a port on 127.0.0.1. A string is the ops
       * API's own canonical http(s) origin, optionally followed by `/`, used
       * with its own host and port.
       */
      opsPortOrUrl: number | string;
      hostedOrigin?: never;
    }
  | {
      /**
       * A canonical http(s) served origin, optionally followed by `/`. The ops
       * calls go to its host at HOSTED_OPS_PORT, the address `resolveOpsUrl`
       * gives for the same string.
       */
      hostedOrigin: string;
      opsPortOrUrl?: never;
    };

export type IdentityMappingParams = IdentityMappingOpsTarget & {
  adminUser: string;
  adminPass: string;
  /** Personal-shape default per #718: one principal per instance. */
  principal: string;
  principalKind: "human" | "agent";
  idpProvider: string;
  idpSubject: string;
  /**
   * flair#2115 — `flair principal link` maps onto a principal that already
   * exists, so a missing one is refused by name with nothing written. Unset
   * (the `flair mcp enable` shape) keeps the create-when-missing behaviour.
   */
  principalMustExist?: boolean;
};

const IDENTITY_MAPPING_TARGET_FORMS =
  `Accepted, exactly one of: opsPortOrUrl as a port number (1-65535) on 127.0.0.1, or as the ops API's own ` +
  `canonical http:// or https:// origin, optionally followed by /, with no credentials, non-root path, query or fragment, used with its own host and port; or ` +
  `hostedOrigin as the same canonical http:// or https:// origin form, whose host is used at port ${HOSTED_OPS_PORT}. ` +
  `The string must exactly equal its parsed URL origin or that origin followed by /. No request was sent.`;

/** Show only the parsed protocol, hostname and port of a refused target. The
 *  display is built without interpolating the raw input, and excludes its
 *  userinfo, path, query and fragment. Parsed components can match input text.
 *  Use the placeholder for a non-string, a parse error or an empty hostname. */
function showOpsTarget(value: unknown): string {
  if (typeof value !== "string") return "<unparseable value>";
  try {
    const u = new URL(value);
    if (!u.hostname) return "<unparseable value>";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "<unparseable value>";
  }
}

/** A URL string is accepted only when parsing leaves its origin spelling
 *  unchanged (apart from an optional `/`). This also rejects empty ? and #. */
function canonicalHttpOrigin(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      !u.username && !u.password &&
      (value === u.origin || value === `${u.origin}/`)
    ) return u;
  } catch {
    // A malformed URL is not an ops target.
  }
  return null;
}

export function targetOriginRefusal(instance: string): string | undefined {
  if (canonicalHttpOrigin(instance)) return;
  const origin = showOpsTarget(instance);
  return "Target must be a canonical http:// or https:// origin, optionally followed by /." +
    (canonicalHttpOrigin(origin) ? ` Use ${origin}.` : "");
}

/** Resolve the ops target, or throw naming the field, its safe display and the
 *  accepted forms. One implementation, so every identity-mapping command sends
 *  its ops calls to the same address (flair#2115). */
function identityMappingOpsUrl(target: IdentityMappingOpsTarget): { url: string; hosted: boolean } {
  const { opsPortOrUrl, hostedOrigin } = target as { opsPortOrUrl?: unknown; hostedOrigin?: unknown };
  const refuse = (what: string): never => {
    throw new Error(`Identity mapping: ${what}. ${IDENTITY_MAPPING_TARGET_FORMS}`);
  };
  if (opsPortOrUrl !== undefined && hostedOrigin !== undefined) {
    return refuse(`got both opsPortOrUrl ${showOpsTarget(opsPortOrUrl)} and hostedOrigin ${showOpsTarget(hostedOrigin)}`);
  }
  if (hostedOrigin !== undefined) {
    const u = canonicalHttpOrigin(hostedOrigin);
    if (!u) {
      return refuse(`cannot read hostedOrigin ${showOpsTarget(hostedOrigin)} as a served origin`);
    }
    return { url: resolveOpsUrl(u.origin), hosted: true };
  }
  if (opsPortOrUrl === undefined) return refuse("got neither opsPortOrUrl nor hostedOrigin");
  if (typeof opsPortOrUrl === "number" && Number.isInteger(opsPortOrUrl) && opsPortOrUrl >= 1 && opsPortOrUrl <= 65535) {
    return { url: resolveOpsUrl(opsPortOrUrl), hosted: false };
  }
  if (typeof opsPortOrUrl === "string") {
    const u = canonicalHttpOrigin(opsPortOrUrl);
    if (u) {
      return { url: `${u.origin}/`, hosted: false };
    }
  }
  return refuse(`cannot tell which ops API opsPortOrUrl ${showOpsTarget(opsPortOrUrl)} names`);
}

export interface IdentityMappingResult {
  principalCreated: boolean;
  credentialId: string;
  credentialReused: boolean;
  /**
   * flair#1317 — did this link REVOKE a prior credential for the same subject?
   * True whenever one or more active credentials for `(kind:"idp", idpSubject)`
   * under a DIFFERENT provider name were superseded. Not a cleanup: those
   * credentials are dead, and anything that depended on them stops resolving.
   */
  credentialSuperseded: boolean;
  /**
   * The ids revoked by this call, in the order they were written. Plural
   * because the pre-fix linking key could already have left several active
   * credentials on one subject — this call heals that state, and the operator
   * needs every id, not just one. Empty when nothing was superseded.
   */
  supersededCredentialIds: string[];
}

/** The resolver's own predicate, verbatim (resources/mcp-handler.ts
 *  `resolveAgentFromSub`): a credential is resolvable unless it is explicitly
 *  revoked. The linking layer MUST use the same test — a credential the linker
 *  considers inactive but the resolver would still serve is exactly the
 *  invisible-duplicate hole #1317 is about. */
function isResolvableCredential(cred: { status?: unknown }): boolean {
  return cred?.status !== "revoked";
}

/**
 * Map the operator's IdP subject to their principal via `Credential(kind:
 * "idp")` — the SAME credential surface resources/mcp-handler.ts's
 * `resolveAgentFromSub` reads at request time.
 *
 * ## The uniqueness constraint (flair#1317, K&S ruling 2026-08-21)
 *
 * **At most one ACTIVE `Credential(kind:"idp", idpSubject:<sub>)` exists at a
 * time, regardless of `idpProvider`.** This function is where that invariant is
 * enforced, because it is the only supported writer of the mapping.
 *
 * It used to dedup on `(kind, idpProvider, idpSubject)` while the resolver read
 * `(kind, idpSubject)`. A re-link under a different provider name therefore
 * matched nothing, INSERTED a second active credential, and left
 * `resolveAgentFromSub` picking whichever row its search iterator served first
 * — identity resolution by iteration order, on a security-relevant mapping.
 *
 * The resolver's key is the correct one and does not change: an IdP subject is
 * an identity, and "who is this subject?" has exactly one answer. `idpProvider`
 * stays on the row as audit/diagnostic metadata, but it does not participate in
 * uniqueness. So:
 *
 *   - same provider, existing active credential → RE-POINT it (`credentialReused`);
 *   - any OTHER active credential for the subject → SUPERSEDE it: terminal
 *     `status: "revoked"`, never a soft flag a later path could flip back
 *     (revoked rows are never reused here — a re-link after a revoke mints a
 *     fresh credential);
 *   - the re-point/insert and every revocation go out as ONE ops-API `upsert`
 *     batch, so there is no observable window with two active credentials or
 *     zero. If the batch fails, nothing is claimed and the call throws;
 *   - after the write the invariant is RE-READ and asserted. A store that
 *     somehow holds ≠1 active credential for the subject is a hard error, not a
 *     silent nondeterministic mapping.
 *
 * The principal Agent is created only if missing.
 *
 * RESIDUAL RISK, by design (Sherlock, #1317): whoever can call this for a
 * subject can revoke that subject's prior credential. If two genuinely
 * different people ever shared a subject string across providers, one's link
 * kills the other's mapping. IdP subjects are opaque per-IdP identifiers so the
 * collision is remote, and the alternative — duplicate active credentials with
 * order-dependent resolution — is strictly worse. `credentialSuperseded` exists
 * so the operator is told, not so the event is hidden.
 */
export async function provisionIdpIdentityMapping(
  params: IdentityMappingParams,
  deps: { fetchImpl?: typeof fetch; now?: () => string } = {},
): Promise<IdentityMappingResult> {
  const target = identityMappingOpsUrl(params);
  const opsUrl = target.url;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  // flair#2359 — the ONE shared agent-ID rule, before any read or write. The
  // principal Agent below is inserted through the operations API, so the Agent
  // resource's own guard never runs on it.
  if (!isValidAgentId(params.principal)) {
    throw new Error(`Identity mapping: ${invalidAgentIdMessage(params.principal)}`);
  }

  // Ensure the principal Agent exists.
  const agentQuery = mappingReadQuery("Agent", { id: params.principal });
  const findRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: opsHeaders(authHeader),
    body: JSON.stringify(agentQuery),
  });
  if (!findRes.ok) {
    const text = await findRes.text().catch(() => "");
    // A MISSING principal is not this branch. The ops API answers an empty
    // search with 200 and [], and the code below creates the principal when the
    // list is empty. Reaching here means the ops CALL failed, not that the
    // identity is absent — and saying "failed to look up principal 'x'" sends
    // the reader to look at principals, which is where an evening goes.
    //
    // For `hostedOrigin`, retain the served-origin diagnosis and explain that
    // `enable` derived the address: it has no option to point its ops calls
    // elsewhere (flair#2116). A 404 at a caller-named opsPortOrUrl does not
    // establish which service answered, so give that path a neutral hint.
    const hint =
      findRes.status === 404
        ? target.hosted
          ? ` — a 404 here usually means ${opsUrl} is the served origin rather than the ops API (the REST component owns "/" and answers 404). The ops API is a DIFFERENT port (conventionally ${HOSTED_OPS_PORT} on hosted instances) and is not derivable from the served port. \`flair mcp enable\` derives this address from the instance URL (--instance or FLAIR_URL: same host, port ${HOSTED_OPS_PORT}) and has no option to override it, so the target's operations API has to answer at ${opsUrl}.`
          : ` — opsPortOrUrl names this address; verify that the ops API answers requests at ${opsUrl}.`
        : "";
    throw new Error(
      `Identity mapping: the ops API call to ${opsUrl} failed (HTTP ${findRes.status})${hint}${text ? `: ${text}` : ""}`,
    );
  }
  // flair#2115 — the principal is created only after a valid empty answer.
  const foundAgents = await opsRecordList(findRes, opsUrl, agentQuery);
  if (foundAgents.length === 0 && params.principalMustExist) {
    throw new Error(principalMissingMessage(params.principal));
  }
  let principalCreated = false;
  const findCredentialsForSubject = (): Promise<any[]> =>
    readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, params.idpSubject);
  const subjectCreds = await findCredentialsForSubject();
  const activeCreds = subjectCreds.filter(isResolvableCredential);
  // flair#2222 — retain Agent presence and the compared principal-bearing IdP fields.
  const preflight = mappingPreflight(params.principal, params.idpSubject, foundAgents.length > 0, subjectCreds);

  if (foundAgents.length === 0) {
    await assertMappingUnchanged(fetchImpl, opsUrl, authHeader, preflight);
    // flair#2433 — the new principal Agent's home is THIS instance's federation
    // id, resolved through the one shared rule. A create stamps it; a body value
    // is never the source.
    const principalHome = await resolveTargetInstanceId(
      agentHomeEndpoint(opsUrl, params.adminUser, params.adminPass, fetchImpl),
    );
    const insertRes = await fetchImpl(opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Agent",
        records: [
          {
            id: params.principal,
            name: params.principal,
            displayName: params.principal,
            kind: params.principalKind,
            type: params.principalKind,
            status: "active",
            publicKey: `idp:${params.idpProvider}:${params.idpSubject}`,
            admin: false,
            defaultTrustTier: "endorsed",
            originatorInstanceId: principalHome,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text().catch(() => "");
      throw new Error(`Identity mapping: failed to create principal '${params.principal}' (HTTP ${insertRes.status}): ${text}`);
    }
    principalCreated = true;
    preflight.principalPresent = true;
  }

  // Survivor: an ACTIVE same-provider credential is re-pointed (the idempotent
  // re-run and the documented same-provider link). A revoked one is never
  // resurrected — a re-link after a revoke mints a fresh credential.
  const reused = activeCreds.find((c) => c?.idpProvider === params.idpProvider && c?.id);
  const credentialId = reused?.id ?? `cred_idp_${params.idpProvider}_${randomBytes(6).toString("hex")}`;

  // Everything else active for this subject is superseded. Under the old
  // (provider, subject) key these rows were simply invisible; they are what made
  // resolution order-dependent.
  const superseded = activeCreds.filter((c) => c?.id && c.id !== credentialId);

  // ONE batched write: the survivor first, then the revocations. A single
  // ops-API operation is the strongest atomicity this surface can express, and
  // ordering the survivor first means even a partially-applied batch can never
  // leave the subject with ZERO resolvable credentials (the fail-open denial).
  await assertMappingUnchanged(fetchImpl, opsUrl, authHeader, preflight, principalCreated);
  const upsertRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      operation: "upsert",
      database: "flair",
      table: "Credential",
      records: [
        {
          id: credentialId,
          principalId: params.principal,
          kind: "idp",
          label: `MCP OAuth (${params.idpProvider})`,
          status: "active",
          idpProvider: params.idpProvider,
          idpSubject: params.idpSubject,
          createdAt: typeof reused?.createdAt === "string" ? reused.createdAt : now,
          lastUsedAt: now,
        },
        // Retained, not deleted: the revocation stays legible in storage and in
        // Harper's table audit log (which records the full record image of
        // every write). Identifying fields are echoed back so the row survives
        // as a well-formed, revoked credential whichever merge semantics the
        // ops API applies.
        ...superseded.map((c) => ({
          id: c.id,
          principalId: c.principalId,
          kind: "idp",
          label: c.label,
          status: "revoked",
          idpProvider: c.idpProvider,
          idpSubject: params.idpSubject,
          createdAt: typeof c.createdAt === "string" ? c.createdAt : now,
          updatedAt: now,
        })),
      ],
    }),
  });
  if (!upsertRes.ok) {
    const text = await upsertRes.text().catch(() => "");
    throw new Error(`Identity mapping: failed to write Credential(kind:idp) mapping (HTTP ${upsertRes.status}): ${text}`);
  }

  // ── The invariant, RE-READ ────────────────────────────────────────────────
  // Asserting what we intended to write proves nothing. This asks the store.
  // ≠1 active credential means the resolver's answer for this subject is
  // order-dependent, so this fails LOUDLY rather than returning a mapping the
  // operator would reasonably believe is deterministic.
  await readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, params.idpSubject, {
    id: credentialId, principalId: params.principal, idpProvider: params.idpProvider, status: "active",
  });

  return {
    principalCreated,
    credentialId,
    credentialReused: Boolean(reused),
    credentialSuperseded: superseded.length > 0,
    supersededCredentialIds: superseded.map((c) => String(c.id)),
  };
}

// ─── flair principal link / unlink / links (flair#2115) ──────────────────────
//
// link maps one IdP login to a principal.
// unlink revokes a mapping.
// links lists current mappings.

/** One current mapping, as `flair principal links` reports it. */
export interface PrincipalMappingRow {
  credentialId: string;
  idpProvider: string;
  idpSubject: string;
}

/** Where the three commands send their ops calls — the same exactly-one target
 *  forms `provisionIdpIdentityMapping` takes (flair#2102), resolved by the same
 *  function (`assertMappingTarget` adds these commands' target policy
 *  first), plus the admin credentials the target's ops API requires. */
export type PrincipalMappingBase = IdentityMappingOpsTarget & {
  adminUser: string;
  adminPass: string;
  principal: string;
};

/** A mapping names one IdP subject under one provider name. */
export type PrincipalMappingParams = PrincipalMappingBase & {
  idpSubject: string;
  idpProvider: string;
};

/** `flair principal links` needs the principal, not a subject. */
export type ListPrincipalMappingsParams = PrincipalMappingBase;

export interface PrincipalMappingDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
}

/** `flair principal link` — `replace` moves a subject already mapped elsewhere. */
export type LinkPrincipalMappingParams = PrincipalMappingParams & { replace?: boolean };

export interface LinkPrincipalMappingResult {
  action: "linked" | "already-linked" | "replaced";
  principal: string;
  idpProvider: string;
  idpSubject: string;
  /** The principal the subject was mapped to before `replace` moved it. */
  previousPrincipal?: string;
  credentialId?: string;
  credentialReused?: boolean;
  supersededCredentialIds: string[];
  /** What to print, in order. Empty-string entries are never produced. */
  lines: string[];
}

export interface UnlinkPrincipalMappingResult {
  principal: string;
  idpSubject: string;
  revokedCredentialIds: string[];
  lines: string[];
}

export interface ListPrincipalMappingsResult {
  principal: string;
  mappings: PrincipalMappingRow[];
  lines: string[];
}

/** The admin Basic header every ops call on this surface carries. */
function opsHeaders(authHeader: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: authHeader };
}

type WrittenMapping = { id: string; principalId: string; idpProvider: string; status: "active" };

type MappingReadQuery = {
  operation: "search_by_value" | "search_by_conditions";
  database: "flair";
  table: "Agent" | "Credential";
  search_attribute?: string;
  search_value?: string;
  operator?: "and";
  conditions?: Array<{ search_attribute: string; search_type: "equals"; search_value: string }>;
  get_attributes: string[];
};

function mappingReadQuery(table: MappingReadQuery["table"], equals: Record<string, string>): MappingReadQuery {
  const fields = table === "Agent" ? ["id"] :
    ["id", "kind", "principalId", "idpProvider", "idpSubject", "status", "label", "createdAt"];
  if (table === "Agent") {
    return { operation: "search_by_value", database: "flair", table,
      search_attribute: "id", search_value: equals.id, get_attributes: fields };
  }
  return { operation: "search_by_conditions", database: "flair", table, operator: "and",
    conditions: Object.entries(equals).map(([search_attribute, search_value]) =>
      ({ search_attribute, search_type: "equals", search_value })), get_attributes: fields };
}

async function opsReadRows(
  fetchImpl: typeof fetch,
  opsUrl: string,
  authHeader: string,
  query: MappingReadQuery,
  written?: WrittenMapping,
  refuseAmbiguous = false,
): Promise<any[]> {
  const res = await fetchImpl(opsUrl, { method: "POST", headers: opsHeaders(authHeader), body: JSON.stringify(query) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Identity mapping: the ops API read at ${opsUrl} failed (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  return opsRecordList(res, opsUrl, query, written, refuseAmbiguous);
}

async function opsRecordList(
  res: Response, opsUrl: string, query: MappingReadQuery, written?: WrittenMapping, refuseAmbiguous = false,
): Promise<any[]> {
  const parsed = await res.json().catch(() => null);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Identity mapping: the ops API read at ${opsUrl} did not answer with a record list; ` +
        `verify that the target answers operations API requests there.`,
    );
  }
  const predicate = query.operation === "search_by_value"
    ? [[query.search_attribute!, query.search_value!]]
    : query.conditions!.map(c => [c.search_attribute, c.search_value]);
  const ids = new Set<string>();
  const rows: any[] = [];
  for (const [index, row] of parsed.entries()) {
    const refuse = (reason: string): never => {
      throw new Error(`Identity mapping: the ops API read at ${opsUrl} answered with a malformed ${query.table} record (entry ${index}): ${reason}.`);
    };
    if (row === null || typeof row !== "object" || Array.isArray(row)) refuse("invalid-row-shape");
    if (!isNonEmptyString(row.id)) refuse("missing-or-invalid-id");
    for (const [field, value] of predicate) {
      if (!query.get_attributes.includes(field)) refuse(`predicate-attribute-not-requested:${field}`);
      if (!Object.hasOwn(row, field) || row[field] !== value) refuse(`query-mismatch:${field}`);
    }
    if (ids.has(row.id)) refuse("duplicate-row-id");
    ids.add(row.id);
    if (query.table === "Credential" && !isNonEmptyString(row.principalId)) continue;
    if (query.table === "Credential" &&
        (typeof row.idpProvider !== "string" ||
         typeof row.idpSubject !== "string" ||
         (row.label != null && typeof row.label !== "string") ||
         (row.status != null && typeof row.status !== "string"))) {
      refuse("missing-or-invalid-credential-field");
    }
    rows.push(row);
  }
  if (refuseAmbiguous && query.table === "Credential" && predicate.some(([field]) => field === "idpSubject")) {
    const principals = [...new Set(rows.filter(isResolvableCredential).map(row => row.principalId))];
    if (principals.length > 1) {
      throw new Error(`Identity mapping: ambiguous-prior-principals: ${principals.join(", ")} — refusing the subject read. Run flair mcp enable to heal this subject mapping.`);
    }
  }
  if (written) {
    const active = rows.filter(isResolvableCredential);
    if (active.length !== 1 || Object.entries(written).some(([field, value]) => active[0][field] !== value)) {
      const subject = predicate.find(([field]) => field === "idpSubject")?.[1];
      const seen = active.map(c => `${c.id} → ${c.principalId} (provider '${c.idpProvider}')`).join("; ") || "none";
      throw new Error(
        `Identity mapping: post-write-mismatch — the uniqueness invariant does not hold after the write (flair#1317) — subject '${subject}' ` +
          `has ${active.length} resolvable (principal-bearing) active Credential(kind:idp) row(s) [${seen}], expected exactly 1 (${written.id}) ` +
          `for principal '${written.principalId}', provider '${written.idpProvider}', status 'active'. ` +
          `Principal-less legacy rows are skipped and may remain active. ` +
          `Inspect the Credential table for kind:"idp" idpSubject:"${subject}" and revoke the rows that should not resolve.`,
      );
    }
  }
  return rows;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

async function readIdpCredentialsForSubject(
  fetchImpl: typeof fetch,
  opsUrl: string,
  authHeader: string,
  idpSubject: string,
  written?: WrittenMapping,
  refuseAmbiguous = false,
): Promise<any[]> {
  return opsReadRows(fetchImpl, opsUrl, authHeader, mappingReadQuery("Credential", { kind: "idp", idpSubject }), written, refuseAmbiguous);
}

async function readIdpCredentialsForPrincipal(
  fetchImpl: typeof fetch,
  opsUrl: string,
  authHeader: string,
  principal: string,
): Promise<any[]> {
  return opsReadRows(fetchImpl, opsUrl, authHeader, mappingReadQuery("Credential", { kind: "idp", principalId: principal }));
}

/**
 * Refuse unless the principal exists, by name.
 *
 * A read that FAILED propagates: an unreadable Agent table is not an absent
 * principal, and this check stands in front of a mapping write (flair#2115).
 * The id is compared, not just the non-emptiness of the answer.
 */
async function assertPrincipalExists(
  fetchImpl: typeof fetch,
  opsUrl: string,
  authHeader: string,
  principal: string,
): Promise<void> {
  const rows = await opsReadRows(fetchImpl, opsUrl, authHeader, mappingReadQuery("Agent", { id: principal }));
  if (rows.length === 0) throw new Error(principalMissingMessage(principal));
}

/** The one refusal a missing principal gets, wherever it is checked. */
function principalMissingMessage(principal: string): string {
  return (
    `No principal '${principal}' — nothing was written. Create the principal on the TARGET instance ` +
    `(run \`flair mcp enable\` against it: it creates the principal it maps), then re-run.`
  );
}

// ─── flair#2222 — the pre-write re-validation bound ───────────────────────────
//
// These separate ops requests offer no compare-and-set or shared transaction.
// Harper 5.2.8 accepts unknown fields (validation/validationWrapper.ts:93-94);
// processLocalTransaction dispatches with ambient user context, preserving an
// existing transaction (server/serverHelpers/serverUtilities.ts:120-136).
// Re-read Agent presence and the canonicalized principal-bearing IdP fields
// before each write. lastUsedAt is not compared. The read/write race remains.

/** Agent presence and selected fields of principal-bearing IdP rows for the subject. */
interface MappingPreflight {
  principal: string;
  idpSubject: string;
  /** Expected presence, including an Agent inserted by this command. */
  principalPresent: boolean;
  /** canonicalSubjectRows' selected fields; principal-less rows were skipped. */
  subjectRows: string;
}

/** Canonicalize id, kind, principalId, idpProvider, idpSubject, status, label and createdAt. */
function canonicalSubjectRows(rows: any[]): string {
  return JSON.stringify(
    rows
      .map((r) => ({
        id: String(r?.id),
        kind: r?.kind ?? null,
        principalId: r?.principalId ?? null,
        idpProvider: r?.idpProvider ?? null,
        idpSubject: r?.idpSubject ?? null,
        status: r?.status ?? null,
        label: r?.label ?? null,
        createdAt: r?.createdAt ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

function mappingPreflight(principal: string, idpSubject: string, principalPresent: boolean, subjectRows: any[]): MappingPreflight {
  return { principal, idpSubject, principalPresent, subjectRows: canonicalSubjectRows(subjectRows) };
}

/** Valid comparison differences refuse here; invalid changed rows can fail earlier validation
 * with missing-or-invalid-credential-field. Both fail closed. */
function mappingChangedMessage(principal: string, idpSubject: string, principalCreated = false): string {
  return (
    `Identity mapping: mapping-changed-underneath — the Agent presence or compared IdP mapping fields for principal '${principal}' ` +
    `and IdP subject '${idpSubject}' changed on the target between this command's validation and its write. ` +
    (principalCreated ? `Agent '${principal}' was created; no rollback was attempted. No Credential write was made. ` : `Nothing was written. `) +
    `Re-run the command.`
  );
}

/**
 * Re-read the state a preflight validated and refuse if it moved.
 *
 * A failed read propagates: an unreadable table is not an unchanged one, and
 * this stands in front of a write. Called immediately before each write in
 * `provisionIdpIdentityMapping`, `linkPrincipalMapping` and
 * `unlinkPrincipalMapping`.
 */
async function assertMappingUnchanged(
  fetchImpl: typeof fetch,
  opsUrl: string,
  authHeader: string,
  preflight: MappingPreflight,
  principalCreated = false,
): Promise<void> {
  const agents = await opsReadRows(fetchImpl, opsUrl, authHeader, mappingReadQuery("Agent", { id: preflight.principal }));
  if ((agents.length > 0) !== preflight.principalPresent) {
    throw new Error(mappingChangedMessage(preflight.principal, preflight.idpSubject, principalCreated));
  }
  const rows = await readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, preflight.idpSubject);
  if (canonicalSubjectRows(rows) !== preflight.subjectRows) {
    throw new Error(mappingChangedMessage(preflight.principal, preflight.idpSubject, principalCreated));
  }
}

/**
 * flair#2115 — `flair principal link|unlink|links` carry the target instance's
 * admin credential to its operations API, so the target they accept is narrower
 * than `checkLocalOriginRefusal`'s claude.ai-oriented one: a `hostedOrigin`
 * that `checkMappingTargetRefusal` refuses is refused. The numeric
 * `opsPortOrUrl` form names the caller's own address and is left alone.
 *
 * Called before the first request, so a refused target never sees one.
 */
function assertMappingTarget(target: IdentityMappingOpsTarget): void {
  const { hostedOrigin } = target as { hostedOrigin?: unknown };
  if (hostedOrigin === undefined) return;
  const check = checkMappingTargetRefusal(String(hostedOrigin));
  if (check.refused) throw new Error(check.message);
}

/** The exactly-one target fields, rebuilt so they can be spread into a fresh
 *  literal (a union value cannot be spread into one). */
function mappingTargetFields(target: IdentityMappingOpsTarget): IdentityMappingOpsTarget {
  const t = target as { opsPortOrUrl?: unknown; hostedOrigin?: unknown };
  return t.hostedOrigin !== undefined
    ? { hostedOrigin: String(t.hostedOrigin) }
    : { opsPortOrUrl: t.opsPortOrUrl as number | string };
}

/**
 * `flair principal link` — map one IdP subject to a principal that already
 * exists, through `provisionIdpIdentityMapping` (the `mcp enable` step).
 *
 * - the subject already mapped to THIS principal (no active row names another):
 *   reported, exit 0, NO write;
 * - the subject mapped to a DIFFERENT principal: refused by name unless
 *   `replace` is set; with `replace`, the write re-points it and the result
 *   names the principal it left;
 * - a missing principal is refused by name with nothing written;
 * - a failed read is refused: it never counts as "no mapping";
 * - a target `checkMappingTargetRefusal` refuses is refused before any request.
 */
export async function linkPrincipalMapping(
  params: LinkPrincipalMappingParams,
  deps: PrincipalMappingDeps = {},
): Promise<LinkPrincipalMappingResult> {
  assertMappingTarget(params);
  const { url: opsUrl } = identityMappingOpsUrl(params);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  // Refuse a missing requested principal before either mapping branch.
  await assertPrincipalExists(fetchImpl, opsUrl, authHeader, params.principal);

  const subjectRows = await readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, params.idpSubject, undefined, true);
  const active = subjectRows.filter(isResolvableCredential);
  const elsewhere = active.filter((c) => c?.principalId !== params.principal);
  if (elsewhere.length > 0 && !params.replace) {
    const current = [...new Set(elsewhere.map((c) => String(c?.principalId)))].join(", ");
    throw new Error(
      `IdP subject '${params.idpSubject}' is already mapped to principal '${current}', not '${params.principal}' — ` +
        `nothing was written. Pass --replace to move it.`,
    );
  }
  if (active.length > 0 && elsewhere.length === 0) {
    const provider = String(active[0]?.idpProvider ?? params.idpProvider);
    return {
      action: "already-linked",
      principal: params.principal,
      idpProvider: provider,
      idpSubject: params.idpSubject,
      supersededCredentialIds: [],
      lines: [
        `Already linked: IdP subject '${params.idpSubject}' (provider '${provider}') → principal '${params.principal}'. No change.`,
      ],
    };
  }
  const previousPrincipal = elsewhere.length > 0 ? String(elsewhere[0]?.principalId) : undefined;

  // flair#2222 — the write is the shared provisioner's; re-validate the state
  // this preflight acted on so a concurrent change refuses here, not after the
  // provisioner has already re-read and moved on.
  await assertMappingUnchanged(fetchImpl, opsUrl, authHeader, mappingPreflight(params.principal, params.idpSubject, true, subjectRows));

  const mapping = await provisionIdpIdentityMapping(
    {
      ...mappingTargetFields(params),
      adminUser: params.adminUser,
      adminPass: params.adminPass,
      principal: params.principal,
      principalKind: "human",
      idpProvider: params.idpProvider,
      idpSubject: params.idpSubject,
      principalMustExist: true,
    },
    deps,
  );

  const outcome = mapping.credentialReused ? "re-pointed" : "created";
  const line =
    previousPrincipal !== undefined
      ? `Re-linked: IdP subject '${params.idpSubject}' (provider '${params.idpProvider}') was mapped to principal ` +
        `'${previousPrincipal}'; now mapped to '${params.principal}' — Credential(kind:idp) ${outcome} (${mapping.credentialId}).` +
        supersededCredentialNote(mapping)
      : `Linked: IdP subject '${params.idpSubject}' (provider '${params.idpProvider}') → principal '${params.principal}' ` +
        `— Credential(kind:idp) ${outcome} (${mapping.credentialId}).` + supersededCredentialNote(mapping);
  return {
    action: previousPrincipal !== undefined ? "replaced" : "linked",
    principal: params.principal,
    idpProvider: params.idpProvider,
    idpSubject: params.idpSubject,
    previousPrincipal,
    credentialId: mapping.credentialId,
    credentialReused: mapping.credentialReused,
    supersededCredentialIds: mapping.supersededCredentialIds,
    lines: [line],
  };
}

/**
 * `flair principal unlink` — revoke the subject's mapping to this principal.
 * A subject not mapped to that principal or carrying a different provider
 * name is refused before writing.
 */
export async function unlinkPrincipalMapping(
  params: PrincipalMappingParams,
  deps: PrincipalMappingDeps = {},
): Promise<UnlinkPrincipalMappingResult> {
  assertMappingTarget(params);
  const { url: opsUrl } = identityMappingOpsUrl(params);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  await assertPrincipalExists(fetchImpl, opsUrl, authHeader, params.principal);

  const subjectRows = await readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, params.idpSubject, undefined, true);
  const active = subjectRows.filter(isResolvableCredential);
  const mine = active.filter((c) => c?.principalId === params.principal);
  if (mine.length === 0) {
    const elsewhere = [...new Set(active.map((c) => String(c?.principalId)))].join(", ");
    throw new Error(
      `IdP subject '${params.idpSubject}' is not mapped to principal '${params.principal}' — nothing was written.` +
        (elsewhere ? ` It is mapped to: ${elsewhere}.` : ` It has no active Credential(kind:idp) mapping.`),
    );
  }
  const providers = [...new Set(mine.map((c) => String(c?.idpProvider)))];
  if (providers.length !== 1 || providers[0] !== params.idpProvider) {
    throw new Error(
      `IdP subject '${params.idpSubject}' is mapped to principal '${params.principal}' under provider ` +
        `'${providers.join(", ")}', not '${params.idpProvider}' — nothing was written. Re-run with ` +
        `--idp-provider ${providers[0]}.`,
    );
  }

  // flair#2222 — re-validate the state this preflight acted on before revoking.
  await assertMappingUnchanged(fetchImpl, opsUrl, authHeader, mappingPreflight(params.principal, params.idpSubject, true, subjectRows));

  const ids = mine.map((c) => String(c?.id));
  const unconfirmedMessage = (unconfirmed: string[]) =>
    `Identity mapping: revocation unconfirmed for Credential IDs: ${unconfirmed.join(", ")}`;
  const res = await fetchImpl(opsUrl, {
    method: "POST",
    headers: opsHeaders(authHeader),
    body: JSON.stringify({
      operation: "update",
      database: "flair",
      table: "Credential",
      records: ids.map((id) => ({ id, status: "revoked", updatedAt: now })),
    }),
  }).catch((err: unknown) => {
    throw new Error(`${unconfirmedMessage(ids)} — ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${unconfirmedMessage(ids)} (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  const result = await res.json().catch(() => null);
  const unconfirmed = ids.filter(id => !writeConfirmed(result, "update_hashes", id));
  if (unconfirmed.length > 0) throw new Error(unconfirmedMessage(unconfirmed));
  const remaining = (await readIdpCredentialsForSubject(fetchImpl, opsUrl, authHeader, params.idpSubject)
    .catch((err: unknown) => {
      throw new Error(`${unconfirmedMessage(ids)} — ${err instanceof Error ? err.message : String(err)}`);
    })).filter(isResolvableCredential);
  if (remaining.length > 0) {
    throw new Error(`${unconfirmedMessage(remaining.map(c => c.id))} — subject '${params.idpSubject}' still has resolvable mappings.`);
  }
  return {
    principal: params.principal,
    idpSubject: params.idpSubject,
    revokedCredentialIds: ids,
    lines: [
      `Unlinked: IdP subject '${params.idpSubject}' is no longer mapped to principal '${params.principal}' — ` +
        `Credential(kind:idp) revoked (${ids.join(", ")}).`,
    ],
  };
}

/**
 * `flair principal links` — the principal's current (active) IdP mappings.
 * A missing principal is refused by name and a failed read is refused too: an
 * empty list is reported only after a valid read with no active mapping.
 */
export async function listPrincipalMappings(
  params: ListPrincipalMappingsParams,
  deps: PrincipalMappingDeps = {},
): Promise<ListPrincipalMappingsResult> {
  assertMappingTarget(params);
  const { url: opsUrl } = identityMappingOpsUrl(params);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authHeader = basicAuthHeader(params.adminUser, params.adminPass);

  await assertPrincipalExists(fetchImpl, opsUrl, authHeader, params.principal);

  const active = (await readIdpCredentialsForPrincipal(fetchImpl, opsUrl, authHeader, params.principal)).filter(
    isResolvableCredential,
  );
  const mappings: PrincipalMappingRow[] = active.map((c) => ({
    credentialId: String(c?.id),
    idpProvider: String(c?.idpProvider),
    idpSubject: String(c?.idpSubject),
  }));
  return {
    principal: params.principal,
    mappings,
    lines:
      mappings.length === 0
        ? [`No IdP mappings for principal '${params.principal}'.`]
        : mappings.map(
            (m) =>
              `IdP subject '${m.idpSubject}' (provider '${m.idpProvider}') → principal '${params.principal}' (${m.credentialId})`,
          ),
  };
}

// ─── Restart only ────────────────────────────────────────────────────────────

/** `restart` only — used by `disableMcp` (flag off + restart, no config
 *  rewrite: the `@harperfast/oauth` config block is left in place; it is
 *  inert whenever `FLAIR_MCP_OAUTH` is unset, per the byte-identical-boot
 *  contract). */
export async function triggerRemoteRestart(
  opsPortOrUrl: number | string,
  adminUser: string,
  adminPass: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const opsUrl = opsBaseUrl(opsPortOrUrl);
  const authHeader = basicAuthHeader(adminUser, adminPass);
  const restartRes = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "restart" }),
  });
  if (!restartRes.ok) {
    const text = await restartRes.text().catch(() => "");
    throw new Error(`restart failed (HTTP ${restartRes.status}): ${text}`);
  }
}

// ─── Self-verify ─────────────────────────────────────────────────────────────

export interface SelfVerifyResult {
  ok: boolean;
  issuer?: string;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  /** Does the AS metadata advertise CIMD support? Requires BOTH
   *  `client_id_metadata_document_supported === true` AND `"none"` present
   *  in `token_endpoint_auth_methods_supported` — the exact pair Anthropic's
   *  docs say Claude's client checks before it will use CIMD instead of
   *  falling back to DCR (see the module header's citation). Populated
   *  whenever the response body parses far enough to check; `undefined`
   *  only when the fetch itself failed or returned non-JSON. */
  cimdSupported?: boolean;
  /** True only when the request itself failed (DNS, connection, TLS, timeout):
   *  no response was read, so nothing is known about the surface's state
   *  (flair#2116). Absent whenever a response came back, whatever its status. */
  unreachable?: true;
  detail: string;
}

/** Fetch and parse the metadata document at an origin without assuming its
 * `issuer` equals that origin. A target can serve a public proxy issuer. */
async function fetchOAuthMetadata(
  origin: string,
  deps: { fetchImpl?: typeof fetch; redirect?: RequestRedirect } = {},
): Promise<{ ok: true; url: string; body: any } | { ok: false; detail: string; unreachable?: true }> {
  const url = `${origin.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(15_000),
      ...(deps.redirect ? { redirect: deps.redirect } : {}),
    });
  } catch (err: any) {
    return { ok: false, unreachable: true, detail: `could not reach ${url}: ${err?.message ?? err}` };
  }
  if (deps.redirect === "manual" && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
    return { ok: false, detail: "--instance answered with a redirect; point --instance at the instance itself." };
  }
  if (!res.ok) {
    return { ok: false, detail: `${url} returned HTTP ${res.status} — is FLAIR_MCP_OAUTH actually set on the restarted instance?` };
  }
  try {
    return { ok: true, url, body: await res.json() };
  } catch {
    return { ok: false, detail: `${url} did not return JSON` };
  }
}

/** The MCP authorization server's token endpoint for `issuer` — the one
 *  derivation of "the MCP token endpoint of this instance", shared by target
 *  binding (`verifyTargetIssuer`) and public self-verification
 *  (`selfVerifyMcpMetadata`) so both checks derive the expected token endpoint
 *  from the same function. */
function mcpTokenEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth/mcp/token`;
}

async function verifyTargetIssuer(
  instance: string,
  issuer: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; detail: string }> {
  const target = await fetchOAuthMetadata(instance, { ...deps, redirect: "manual" });
  const remedy = `Check the OAuth authorization-server metadata served by --instance (${instance}), make sure the target's FLAIR_MCP_ISSUER is ${issuer}, then re-run \`flair mcp enable\`.`;
  if (target.ok === false) return { ok: false, detail: `Cannot confirm the target's configured issuer: ${target.detail} ${remedy}` };
  if (target.body?.issuer !== issuer) {
    const actual = target.body?.issuer;
    const found = typeof actual === "string" ? `names issuer=${JSON.stringify(actual)}` : `has no string issuer (got ${JSON.stringify(actual)})`;
    return { ok: false, detail: `The target's own metadata at ${target.url} ${found}; expected ${issuer}. ${remedy}` };
  }
  if (target.body?.token_endpoint !== mcpTokenEndpoint(issuer)) {
    return {
      ok: false,
      detail: `The target's metadata at ${target.url} has token_endpoint=${JSON.stringify(target.body?.token_endpoint)}, not the MCP authorization server's token endpoint. Check FLAIR_MCP_OAUTH and the @harperfast/oauth component on the target, then re-run \`flair mcp enable\`.`,
    };
  }
  return { ok: true, detail: `Issuer ${issuer} matched the target's own OAuth authorization-server metadata at ${target.url}` };
}

/**
 * Hit the OAuth metadata endpoint from the operator's machine against the
 * PUBLIC origin — the verification that matters is the one claude.ai's
 * perspective sees (scenario addendum). Never reports success on hope: any
 * unreachable/malformed/mismatched response, OR a response that doesn't
 * advertise CIMD support, is `ok: false` with a specific `detail`.
 *
 * flair#756: since CIMD is the only supported client-registration path now,
 * this checks the public metadata's issuer, MCP token endpoint, and CIMD
 * advertisement; it does not exercise the token route or `/mcp`. The check
 * is reused by `enable`'s self-verify step, `grant`/`revoke`'s workflow gate
 * (src/commands/mcp.ts), and `flair mcp status`, so all four commands use the same
 * public metadata criterion.
 */
export async function selfVerifyMcpMetadata(
  issuer: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SelfVerifyResult> {
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const metadata = await fetchOAuthMetadata(normalizedIssuer, deps);
  if (metadata.ok === false) return metadata;
  const { url, body } = metadata;
  // ── The flair's-own-server check runs BEFORE the shape check (flair#1094) ──
  //
  // It used to run after, and that made the DEFAULT flag-off case misreport.
  // flair's own document omits `registration_endpoint` unless DCR is enabled,
  // which it is not by default — so the shape check fired first and returned
  // "the metadata shape is unexpected", which is true, useless, and points at
  // shapes when the cause is an unset environment variable.
  //
  // `token_endpoint` is present in that document either way, so testing the
  // discriminator first names the real cause in EVERY flag-off case rather than
  // only when DCR happens to be on. Found by writing the test that pins this
  // relationship, not by reading the code.
  if (typeof body?.token_endpoint === "string" && body.token_endpoint === `${normalizedIssuer}/OAuthToken`) {
    return {
      ok: false,
      issuer: body?.issuer,
      registrationEndpoint: body?.registration_endpoint,
      tokenEndpoint: body.token_endpoint,
      detail:
        `${url} answered with flair's OWN OAuth 2.1 authorization server, not the MCP one ` +
        `(token_endpoint=${body.token_endpoint}) — the /mcp surface is NOT enabled on that instance. ` +
        `Is FLAIR_MCP_OAUTH actually set on the restarted instance, and is the '@harperfast/oauth' ` +
        `component declared in its config.yaml?`,
    };
  }
  // ── registration_endpoint is OPTIONAL and must not be required (Kern, #1101) ─
  //
  // Requiring it made self-verify fail on a CORRECTLY enabled instance — the
  // exact configuration `enable` itself creates.
  //
  // RFC 8414 marks the field optional, and BOTH authorization servers in this
  // system omit it when DCR is off:
  //   - flair's own AS: resources/oauth-discovery.ts, conditional spread on
  //     dcrEnabled(), default off.
  //   - the MCP plugin: @harperfast/oauth/dist/lib/mcp/wellKnown.js:142,
  //     `...(dcrEnabled(mcpConfig) ? { registration_endpoint: … } : {})`.
  //
  // And `enable` writes `dynamicClientRegistration: { enabled: false }` by
  // design — DCR is unsupported on this surface (#756). So the plugin omits the
  // field on every instance this command configures, and self-verify then
  // reported "the metadata shape is unexpected" on a working MCP surface,
  // sending the operator to debug metadata fields instead.
  //
  // The module header above still claims the plugin advertises it
  // "unconditionally". That was true of the version it was written against and
  // is false of the installed one — corrected there too. A verified fact carries
  // the date it was verified, and this one expired.
  //
  // Required: issuer and token_endpoint, both always present in both servers.
  // registration_endpoint is validated only when it appears.
  if (
    body?.issuer !== normalizedIssuer ||
    typeof body?.token_endpoint !== "string" ||
    (body?.registration_endpoint !== undefined && typeof body.registration_endpoint !== "string")
  ) {
    return {
      ok: false,
      detail: `${url} responded but the metadata shape is unexpected (issuer/token_endpoint) — got issuer=${JSON.stringify(body?.issuer)}`,
    };
  }

  // flair#1000: this path is now served by flair ITSELF when FLAIR_MCP_OAUTH is
  // off, so a 200 no longer proves the plugin answered. flair's own document
  // (resources/oauth-discovery.ts) is identifiable by its token endpoint —
  // `<issuer>/OAuthToken`, where the plugin's is `<issuer>/oauth/mcp/token`.
  // Name the real cause here: before this existed the operator got a 404 whose
  // message already asked the right question, and falling through to the CIMD
  // branch would send them to a plugin knob that is not the problem.
  if (body.token_endpoint === `${normalizedIssuer}/OAuthToken`) {
    return {
      ok: false,
      issuer: body.issuer,
      registrationEndpoint: body.registration_endpoint,
      tokenEndpoint: body.token_endpoint,
      detail:
        `${url} answered with flair's OWN OAuth 2.1 authorization server, not the MCP one ` +
        `(token_endpoint=${body.token_endpoint}) — the /mcp surface is NOT enabled on that instance. ` +
        `Is FLAIR_MCP_OAUTH actually set on the restarted instance, and is the '@harperfast/oauth' ` +
        `component declared in its config.yaml?`,
    };
  }

  // flair#756: confirm CIMD is actually advertised (node_modules/@harperfast/
  // oauth/dist/lib/mcp/wellKnown.js:129-165's buildAuthorizationServerMetadata:
  // `client_id_metadata_document_supported` is set only when
  // clientIdMetadataDocuments.enabled !== false; `token_endpoint_auth_methods_
  // supported` always includes "none"). Both are required per Anthropic's docs
  // before Claude will use CIMD (see module header).
  const cimdSupported =
    body?.client_id_metadata_document_supported === true &&
    Array.isArray(body?.token_endpoint_auth_methods_supported) &&
    body.token_endpoint_auth_methods_supported.includes("none");
  if (!cimdSupported) {
    return {
      ok: false,
      issuer: body.issuer,
      registrationEndpoint: body.registration_endpoint,
      tokenEndpoint: body.token_endpoint,
      cimdSupported: false,
      detail: `${url} answered but does not advertise CIMD support (client_id_metadata_document_supported / "none" in token_endpoint_auth_methods_supported) — is clientIdMetadataDocuments.enabled explicitly false?`,
    };
  }

  // flair#2190: the public document must name the MCP authorization server's
  // token endpoint exactly — the same derivation target binding requires
  // (mcpTokenEndpoint). The flair's-own-server and CIMD checks above run
  // first, so those cases keep their specific remedies.
  if (body.token_endpoint !== mcpTokenEndpoint(normalizedIssuer)) {
    return {
      ok: false,
      issuer: body.issuer,
      registrationEndpoint: body.registration_endpoint,
      tokenEndpoint: body.token_endpoint,
      cimdSupported: true,
      detail:
        `Found token_endpoint=${JSON.stringify(body.token_endpoint)} in ${url}, not the MCP authorization server's ` +
        `expected token_endpoint=${mcpTokenEndpoint(normalizedIssuer)}. This metadata cannot verify the MCP endpoint. ` +
        `Check the public OAuth authorization-server metadata or proxy for ${normalizedIssuer}, then re-run \`flair mcp enable\`.`,
    };
  }

  return {
    ok: true,
    issuer: body.issuer,
    registrationEndpoint: body.registration_endpoint,
    tokenEndpoint: body.token_endpoint,
    cimdSupported: true,
    detail: "OAuth metadata endpoint answering on the public origin, advertising CIMD support",
  };
}

/** The exact block to paste into claude.ai → Settings → Connectors. No
 *  client ID to hand over — CIMD-based connectors have Claude present its
 *  OWN client_id (a URL it hosts), never one this server issues. */
export function buildClaudePasteBlock(resource: string): string {
  return [
    "claude.ai → Settings → Connectors → Add custom connector",
    `  URL: ${resource}`,
    "  (no client ID to enter — Claude presents its own Client ID Metadata Document URL automatically)",
  ].join("\n");
}

// ─── Restart verification (flair#1120) ───────────────────────────────────

/** A boot discriminator: the Harper core process PID from
 *  `system_information` (`harperdb_processes` attribute).
 *  Used to verify the process actually restarted after a restart call. */
export interface BootDiscriminator {
  pid: number;
}

/** How long to wait for the ops API / PID change after a restart. */
const RESTART_WAIT_TIMEOUT_MS = 30_000;
/** Poll interval while waiting for the ops API after restart. */
const RESTART_WAIT_POLL_MS = 1000;

/**
 * Wait for the ops API to respond after a restart, then poll until the PID
 * changes (proving a genuine restart, not the old process still answering).
 *
 * After a real restart, the old process can briefly still respond to the first
 * ops request. We capture the PID on every poll until it changes — if the
 * window expires with the PID still the same we report thread-bounce failure
 * so the operator knows the restart was a no-op rather than a timing quirk.
 *
 * `timeoutMs` and `pollMs` are injectable via `deps` so tests can run fast.
 */
async function waitForOpsApi(
  opsUrl: string,
  authHeader: string,
  prePid: number,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; pollMs?: number } = {},
): Promise<BootDiscriminator> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? RESTART_WAIT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? RESTART_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetchImpl(opsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ operation: "system_information", attributes: ["harperdb_processes"] }),
        signal: AbortSignal.timeout(3000),
        });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
       }
       // Ops API answered — extract the PID from this response
      const data: { harperdb_processes?: { core?: { pid?: number }[] } } = await res.json();
      const pid = data?.harperdb_processes?.core?.[0]?.pid;
      if (!pid || typeof pid !== "number") {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
       }
       // If PID changed from pre-restart value, the restart is confirmed
      if (pid !== prePid) return { pid };
       // PID still the same (old process may still be answering), keep polling
     } catch { /* not ready yet — connection refused, timeout, etc. */ }
    await new Promise((r) => setTimeout(r, pollMs));
   }
  throw new Error(
     `ops API at ${opsUrl} did not confirm a new process within ${timeoutMs}ms (${attempt} attempts) ` +
     `— the restart may have failed or the process bounced on the same thread (pid ${prePid} unchanged). ` +
     `Restart the instance manually, then re-run: flair mcp enable`,
   );
}

/**
 * Capture the Harper core process PID from the ops API via `system_information`.
 * This PID is the boot discriminator: it changes on every real restart.
 */
export async function captureBootDiscriminator(
  opsPortOrUrl: number | string,
  adminUser: string,
  adminPass: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<BootDiscriminator> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const opsUrl = resolveOpsUrl(opsPortOrUrl);
  const authHeader = basicAuthHeader(adminUser, adminPass);

  const res = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ operation: "system_information", attributes: ["harperdb_processes"] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`system_information failed (HTTP ${res.status}): ${text}`);
  }
  const data: { harperdb_processes?: { core?: { pid?: number }[] } } = await res.json();
  const pid = data?.harperdb_processes?.core?.[0]?.pid;
  if (!pid || typeof pid !== "number") {
    throw new Error("system_information returned no harperdb_processes.core entry with a PID");
  }
  return { pid };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export type EnableStepName =
  | "principal-id-check"
  | "local-origin-check"
  | "target-shape-check"
  | "issuer-origin-check"
  | "cimd-allowed-hosts"
  | "config-block"
  | "idp-credentials"
  | "secrets-provisioning"
  | "identity-mapping"
  | "local-config-update"
  | "issuer-target-binding"
  | "fabric-operator-deploy"
  | "restart"
  | "verify-restart"
  | "self-verify";

export interface EnableStepResult {
  step: EnableStepName;
  ok: boolean;
  detail: string;
}

export interface EnableMcpParams {
  instance: string;
  /** Public origin claude.ai will use; defaults to `instance`. */
  issuer?: string;
  idpProvider?: string;
  idpClientId?: string;
  idpClientSecret?: string;
  /** The operator's expected `sub`/login at the IdP (GitHub's `usernameClaim`
   *  is `login` — verify at first live login if unsure; `flair mcp status`
   *  surfaces mismatches). Required — never guessed. */
  idpSubject?: string;
  principal?: string;
  principalKind?: "human" | "agent";
  adminUser: string;
  adminPass: string;
  secretsMechanism?: SecretsMechanism;
  secretsStagingPath?: string;
  /** flair#2113: lowercase bare hostnames ensured as
   *  `mcp.clientIdMetadataDocuments.allowedHosts` in the local config.yaml
   *  (`localConfigPath`, else `./config.yaml`, else `~/.flair/config.yaml`)
   *  before the restart (written unless that file already holds that exact
   *  list, then read back), and only after the preflight match in
   *  `checkTargetRunsFromConfig`. Refused, before anything changes, for a Fabric
   *  origin, for invalid entries, when that file is missing, cannot be parsed,
   *  or has no `@harperfast/oauth` → `mcp` block, and (without `dryRun`) when
   *  the match fails. `dryRun` skips the match and writes nothing. Unset: the
   *  list is not touched. */
  cimdAllowedHosts?: string[];
  dryRun?: boolean;
  /** Operator confirms the staged secrets are live in the target's process
   *  environment. Required (or an interactive `prompt` confirmation) before
   *  `enable` calls restart — never assumed. */
  confirmSecretsApplied?: boolean;
  fabric?: boolean;
  /** Path to the local component config.yaml for standalone-local installs.
   *  When set, enable flips mcp.enabled to true before restarting.
   *  When unset, enable tries common locations (./config.yaml,
   *  ~/.flair/config.yaml). */
  localConfigPath?: string;
}

export interface EnableMcpDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
  /** Interactive confirmation (CLI wires readline; tests inject a stub).
   *  Only consulted when `confirmSecretsApplied` is not already true and
   *  this is not a dry run. */
  confirmPrompt?: (message: string) => Promise<boolean>;
    /** Timeout (ms) for waitForOpsApi — injectable so tests run fast. */
  waitForOpsApiTimeoutMs?: number;
    /** Poll interval (ms) for waitForOpsApi — injectable so tests run fast. */
  waitForOpsApiPollMs?: number;
  /** flair#2113: `checkTargetRunsFromConfig` seams (process cwd and command line, local hostname). */
  readProcessCwd?: (pid: number) => string | null;
  readProcessCmdline?: (pid: number) => string | null;
  localHostname?: () => string;
}

export interface EnableMcpResult {
  ok: boolean;
  dryRun: boolean;
  refused?: { message: string; reason?: "invalid" | "local" };
  steps: EnableStepResult[];
  failedStep?: EnableStepName;
  issuer?: string;
  resource?: string;
  pasteBlock?: string;
  secretsMechanism?: SecretsMechanism;
  secretsPath?: string;
  callbackUrl?: string;
  /** flair#2113: set only when this run wrote `--cimd-allowed-hosts` to
   *  `cimdAllowedHostsConfigPath` (or found it already there) — the list read
   *  back from that file. */
  cimdAllowedHosts?: string[];
  cimdAllowedHostsConfigPath?: string;
}

/**
 * flair#1317/#2115 — the note a mapping reports when it revoked a prior
 * credential for the subject. Returned with a leading space so it appends to a
 * line, and empty when nothing was superseded. One implementation, so `flair
 * principal link` prints it exactly as `flair mcp enable` does.
 */
function supersededCredentialNote(mapping: IdentityMappingResult): string {
  return mapping.credentialSuperseded
    ? ` SUPERSEDED: ${mapping.supersededCredentialIds.length} prior Credential(kind:idp) row(s) for this subject ` +
      `were REVOKED, not de-duplicated — ${mapping.supersededCredentialIds.join(", ")}. ` +
      `The revoked rows no longer resolve. Future calls for this subject use the surviving mapping. ` +
      `Exactly one resolvable (principal-bearing) active credential remains per (kind, idpSubject). Principal-less legacy rows are skipped and may remain active.`
    : "";
}

/**
 * Full `flair mcp enable` orchestration. No `process.exit`, no console
 * output — directly unit-testable with a mocked fetch and temp dirs, same
 * split as `grantMcpClient`/`revokeMcpClient`. Returns a step-by-step log so
 * a failure names exactly which step to re-run (never reports success on
 * hope).
 *
 * flair#756: no DCR step anywhere in this flow — CIMD needs no
 * pre-registration. The target's MCP metadata issuer is
 * checked before the public issuer metadata can count as completion.
 */
export async function enableMcp(params: EnableMcpParams, deps: EnableMcpDeps = {}): Promise<EnableMcpResult> {
  const steps: EnableStepResult[] = [];
  // The step currently executing, so a throw is attributed to IT rather than to
  // the last step that succeeded (flair#1087).
  //
  // `push` deliberately takes NO step name: it reads this variable. A name passed
  // per-call would be the same string typed twice (once here, once at the push),
  // and the two drifting apart is precisely the misattribution #1087 is about —
  // a rule that only a comment or a source scan could enforce. Deriving it makes
  // a wrong name unrepresentable instead of merely discouraged, so there is
  // nothing left for a reviewer to check.
  //
  // Initialised to the first step rather than left undefined so a throw before
  // any assignment cannot be attributed to an arbitrary fallback name.
  let currentStep: EnableStepName = "target-shape-check";
  const dryRun = Boolean(params.dryRun);
  const push = (ok: boolean, detail: string) => steps.push({ step: currentStep, ok, detail });

  const targetRefusal = targetOriginRefusal(params.instance) ?? fabricLoopbackRefusal(params.instance, params.fabric);
  if (targetRefusal) {
    currentStep = "target-shape-check";
    push(false, targetRefusal);
    return { ok: false, dryRun, refused: { message: targetRefusal }, steps, failedStep: "target-shape-check" };
  }

  // ── Local-origin refusal (scenario addendum, binding) ─────────────────────
  currentStep = "local-origin-check";
  const rawIssuer = params.issuer ?? params.instance;
  const issuer = rawIssuer.replace(/\/$/, "");
  const localCheck = checkLocalOriginRefusal(issuer);
  if (localCheck.refused) {
    push(false, localCheck.message);
    return { ok: false, dryRun, refused: { reason: localCheck.reason, message: localCheck.message }, steps, failedStep: "local-origin-check" };
  }
  push(true, `${issuer}: URL parsed; hostname/IP-literal check passed (no DNS lookup)`);

  const idpProvider = params.idpProvider ?? "github";
  const principal = params.principal ?? "self";
  const principalKind = params.principalKind ?? "human";

  // flair#2359 — the resolved principal becomes the id of the Agent row the
  // identity-mapping step writes, so it must satisfy the shared agent-ID rule
  // before the dry run reports success and before any secrets are staged or
  // pushed.
  if (!isValidAgentId(principal)) {
    currentStep = "principal-id-check";
    const message = `principal: ${invalidAgentIdMessage(principal)} Nothing was changed.`;
    push(false, message);
    return { ok: false, dryRun, refused: { reason: "invalid", message }, steps, failedStep: "principal-id-check" };
  }

  const fabricTarget = isFabricTarget(params.instance, params.fabric);

  try {
    // ── Issuer origin (flair#2194) ────────────────────────────────────────────
    currentStep = "issuer-origin-check";
    const issuerIssue = issuerOriginRefusal(rawIssuer);
    if (issuerIssue) {
      push(false, issuerIssue);
      return { ok: false, dryRun, refused: { message: issuerIssue }, steps, failedStep: "issuer-origin-check" };
    }
    push(true, `issuer ${issuer} is an absolute http(s) origin`);
    if (!dryRun && !fabricTarget && !isLoopbackUrl(params.instance)) {
      currentStep = "target-shape-check";
      const message =
        `${params.instance} is not a loopback URL or a *.harperfabric.com target. ` +
        `For Harper Fabric behind a custom domain, use --fabric. Nothing was changed.`;
      push(false, message);
      return { ok: false, dryRun, refused: { message }, steps, failedStep: "target-shape-check" };
    }

    // ── --cimd-allowed-hosts (flair#2113) ─────────────────────────────────────
    let cimdAllowedHosts: string[] | undefined;
    if (params.cimdAllowedHosts !== undefined) {
      currentStep = "cimd-allowed-hosts";
      const refuse = (message: string): EnableMcpResult => {
        push(false, message);
        return { ok: false, dryRun, refused: { message }, steps, failedStep: "cimd-allowed-hosts" };
      };
      try {
        cimdAllowedHosts = validateCimdAllowedHosts(params.cimdAllowedHosts);
      } catch (err: any) {
        return refuse(err?.message ?? String(err));
      }
      const shapeRefusal = cimdAllowedHostsShapeRefusal(params.instance, params.fabric);
      if (shapeRefusal) return refuse(shapeRefusal);
      const current = readLocalConfigCimdAllowedHosts(params.localConfigPath);
      if (!current.ok) {
        return refuse(
          `--cimd-allowed-hosts cannot be applied: ${current.detail}. Run this command on the instance's host, from the ` +
            `directory that holds the config.yaml it runs from, or edit ${CIMD_ALLOWED_HOSTS_CONFIG_KEY} there by hand. ` +
            `Nothing was changed.`,
        );
      }
      const change =
        `${CIMD_ALLOWED_HOSTS_CONFIG_KEY} in ${current.path}: ${JSON.stringify(current.current ?? null)} -> ` +
        `${JSON.stringify(cimdAllowedHosts)}`;
      if (dryRun) {
        push(true, `${change} (--dry-run: the target was not checked, and the list was not written)`);
      } else {
        const target = await checkTargetRunsFromConfig(
          params.instance, params.adminUser, params.adminPass, current.path!,
          {
            fetchImpl: deps.fetchImpl,
            readProcessCwd: deps.readProcessCwd,
            readProcessCmdline: deps.readProcessCmdline,
            localHostname: deps.localHostname,
          },
        );
        if (!target.ok) {
          return refuse(
            `--cimd-allowed-hosts refused: ${target.detail}. Edit ${CIMD_ALLOWED_HOSTS_CONFIG_KEY} by hand in the ` +
              `config.yaml the target runs from, on its host, then restart it. Nothing was changed.`,
          );
        }
        push(true,
          `${change} (the local-config-update step, before the restart, writes it unless the file already holds that exact list, ` +
            `then reads it back; a run that stops before that step does not write it); ${target.detail}`,
        );
      }
    }

    // ── @harperfast/oauth config (flair#1136: shipped in config.yaml) ──────
    // The block ships uncommented with mcp.enabled: ${FLAIR_MCP_OAUTH}
    // (flair#1152), so the environment turns it on. This step writes nothing;
    // it reports the block config.yaml ships (flair#2116: it used to print
    // false), and a --cimd-allowed-hosts value only as requested, never as shipped.
    // set_configuration is removed — the block lives in the component's own
    // config.yaml, not in harperdb-config.yaml where Fabric would wipe it.
    currentStep = "config-block";
    push(true,
      `@harperfast/oauth config ships in config.yaml; this step writes nothing (mcp.enabled=${MCP_ENABLED_ENV_REFERENCE}, read from the instance environment; ` +
        `dynamicClientRegistration.enabled=false, clientIdMetadataDocuments.allowedHosts=${JSON.stringify(DEFAULT_CIMD_ALLOWED_HOSTS)})` +
        (cimdAllowedHosts
          ? `; --cimd-allowed-hosts ${JSON.stringify(cimdAllowedHosts)} was requested; the cimd-allowed-hosts step above says whether and when this run writes it`
          : ""),
    );

    // ── IdP OAuth-app credential intake ───────────────────────────────────────
    currentStep = "idp-credentials";
    const callbackUrl = idpCallbackUrl(issuer, idpProvider);
    if (!params.idpClientId || !params.idpClientSecret || !params.idpSubject) {
      const missing = [
        !params.idpClientId && "--idp-client-id",
        !params.idpClientSecret && "--idp-client-secret",
        !params.idpSubject && "--idp-subject",
      ].filter(Boolean).join(", ");
      push(false,
        `missing ${missing}. Create a ${idpProvider} OAuth app with callback URL ${callbackUrl}, then re-run with the credentials.`,
      );
      return { ok: false, dryRun, steps, failedStep: "idp-credentials", callbackUrl };
    }
    push(true, `${idpProvider} OAuth app credentials present; callback URL: ${callbackUrl}`);

    if (dryRun) {
      // Dry-run stops here. Under --dry-run nothing above wrote a file or made
      // a remote call, and nothing below this line runs.
      return {
        ok: true,
        dryRun: true,
        steps,
        issuer,
        resource: `${issuer}/mcp`,
        callbackUrl,
      };
    }

    // ── Secrets provisioning (shape-aware, never silent) ──────────────────────
    currentStep = "secrets-provisioning";
    const bundle = buildSecretsBundle({
      issuer,
      idpProvider,
      idpClientId: params.idpClientId,
      idpClientSecret: params.idpClientSecret,
    });
    if (bundle.FLAIR_MCP_ISSUER !== issuer) {
      throw new Error(`the FLAIR_MCP_ISSUER being pushed does not equal the issuer checked (${issuer})`);
    }
    // Stage first, unconditionally. If the push works the file is a no-op the
    // operator never opens; if anything about the push is uncertain they still
    // have the thing that always works, without a re-run. Staging costs a 0600
    // write; not staging costs an operator stranded mid-enable.
    const secretsResult = provisionSecrets(params.instance, bundle, {
      mechanism: params.secretsMechanism,
      fabric: params.fabric,
      stagingPath: params.secretsStagingPath,
    });

    // Ask the TARGET whether it can take these, rather than inferring from its
    // hostname or its version.
    // An explicit --secrets-mechanism is an operator override and is honoured
    // without a probe: they have said what they want.
    let secretsPushed = false;
    if (!params.secretsMechanism) {
      const cap = await probeSecretsCapability(
        resolveOpsUrl(params.instance),
        basicAuthHeader(params.adminUser, params.adminPass),
        { fetchImpl: deps.fetchImpl },
      );
      if (cap.available && cap.publicKeyPem) {
        const pushResult = await pushSecrets(
          resolveOpsUrl(params.instance),
          basicAuthHeader(params.adminUser, params.adminPass),
          bundle,
          cap.publicKeyPem,
          { fetchImpl: deps.fetchImpl },
        );
        secretsPushed = pushResult.allOk;
        if (secretsPushed) {
          push(true,
            `${secretsResult.varNames.length} vars pushed to the target as enc:v1 env-secrets (tier ${PROCESS_ENV_TIER}); ` +
              `values were sealed locally and never sent in plaintext. Staged copy at ${secretsResult.path} (0600) is unused. ` +
              `Self-verify below is what proves they were DECRYPTED into the process — a target that stores them without an ` +
              `active env-secrets decryptor will fail there, not here.`,
          );
        } else {
          const failed = pushResult.results.filter((r) => !r.ok).map((r) => `${r.name} (${r.detail})`).join("; ");
          push(true,
            `push attempted and did not complete for: ${failed}. Falling back to the staged file at ${secretsResult.path} (0600). ` +
              `${secretsResult.instructions}`,
          );
        }
      } else {
        push(true,
          `mechanism: ${secretsResult.mechanism}; ${secretsResult.varNames.length} vars staged at ${secretsResult.path} (0600). ` +
            `${cap.reason}. ${secretsResult.instructions}`,
        );
      }
    } else {
      push(true,
        `mechanism: ${secretsResult.mechanism} (explicit --secrets-mechanism, no capability probe); ` +
          `${secretsResult.varNames.length} vars staged at ${secretsResult.path} (0600). ${secretsResult.instructions}`,
      );
    }

    // ── Identity mapping (Credential kind:idp) ────────────────────────────────
    currentStep = "identity-mapping";
    const mapping = await provisionIdpIdentityMapping(
      {
        // The instance URL is the served origin: ask for its host at the hosted
        // ops port, the address resolveOpsUrl gives the other steps (flair#2102).
        hostedOrigin: params.instance,
        adminUser: params.adminUser,
        adminPass: params.adminPass,
        principal,
        principalKind,
        idpProvider,
        idpSubject: params.idpSubject,
      },
      { fetchImpl: deps.fetchImpl, now: deps.now },
    );
    // flair#1280 — provisioning legibility: distinct identities are the
    // DEFAULT (a connector sub is not your CLI agent unless you link them),
    // and the one silent failure mode this surface has is discovering that
    // via an empty bootstrap. So the step that creates the mapping states it
    // plainly, names the link remedy, and points at the runtime diagnostic.
    // flair#1317 — a cross-provider re-link REVOKES the subject's prior
    // credential (one active credential per subject is the invariant). That is
    // a credential dying, so it is stated as such, by id: an operator must
    // never discover it later from something that stopped working.
    const supersedeNote = supersededCredentialNote(mapping);
    push(true,
      `connector identity: mapped sub '${params.idpSubject}' (provider '${idpProvider}') to Agent '${principal}'; ` +
        `see docs/access-control.md for how /mcp tool calls use it. ` +
        `principal ${mapping.principalCreated ? "created" : "already existed"}; ` +
        `Credential(kind:idp) ${mapping.credentialReused ? "re-pointed" : "created"} (${mapping.credentialId}).` +
        `${supersedeNote} ` +
        `If your CLI signs as a DIFFERENT agent id, the connector sees that agent's DISTINCT memory scope (by design) — ` +
        `re-run with --principal <your-agent-id> to link them. ` +
        `Diagnostic: the bootstrap tool's agentId/scope fields always say who the server resolved you to.`,
    );

    // ── Gate: require confirmation that the secrets are live before continuing
    let confirmed = Boolean(params.confirmSecretsApplied);
    if (!confirmed && deps.confirmPrompt) {
      confirmed = await deps.confirmPrompt(
        secretsPushed
          ? fabricTarget
            ? `The ${secretsResult.varNames.length} secrets were pushed to ${params.instance} and read back. Have you restarted the Fabric instance to load them?`
            : `The ${secretsResult.varNames.length} secrets were pushed to ${params.instance} and read back. Have you loaded them into the instance's process environment?`
          : `Have you applied the ${secretsResult.varNames.length} vars staged at ${secretsResult.path} to ${params.instance}'s environment?`,
      );
    }
    if (!confirmed) {
      push(false,
        secretsPushed
          ? `not confirmed: the secrets were pushed to ${params.instance} and read back; ${fabricTarget ? "restart the Fabric instance" : "load them into the instance's process environment"}, then re-run \`flair mcp enable\` with --confirm-secrets-applied.`
          : `not applied: pass --confirm-secrets-applied once the staged secrets are live on ${params.instance}, then re-run \`flair mcp enable\` (earlier steps are idempotent and will reuse what's already provisioned).`,
      );
      return { ok: false, dryRun, steps, failedStep: "secrets-provisioning", secretsMechanism: secretsResult.mechanism, secretsPath: secretsResult.path };
    }

    // ── flair#1136: config delivery is now SHIPPED in config.yaml ────────────
    // The @harperfast/oauth block ships uncommented with mcp.enabled:
    // ${FLAIR_MCP_OAUTH} (flair#1152). set_configuration is REMOVED — Fabric
    // regenerates harperdb-config.yaml on every container restart, so writing
    // the block there was always a race against the next deploy. Instead:
    //
    //   - Standalone-local: set mcp.enabled to the env reference in the local
    //     config.yaml (updateLocalConfigMcpEnabled), restart, self-verify.
    //   - Fabric: `enable` does not restart the instance; the operator applies
    //     the environment and restarts. Report the requirement LOUDLY — never
    //     report success with /mcp still dark.
    if (fabricTarget) {
      // ── Fabric: operator-deploy requirement ──────────────────────────────
      currentStep = "fabric-operator-deploy";
      const host = new URL(params.instance).hostname;
      // flair#2116: this step used to fail unconditionally, so a re-run after
      // the operator's restart ended here with the same instructions, forever.
      currentStep = "issuer-target-binding";
      const binding = await verifyTargetIssuer(params.instance, issuer, { fetchImpl: deps.fetchImpl });
      if (!binding.ok) {
        push(false, binding.detail);
        return { ok: false, dryRun, refused: { message: binding.detail }, steps, failedStep: "issuer-target-binding", issuer, resource: `${issuer}/mcp`, secretsMechanism: secretsResult.mechanism, secretsPath: secretsResult.path, callbackUrl };
      }
      currentStep = "fabric-operator-deploy";
      // The target's metadata names the issuer. Now check the public origin.
      const live = await selfVerifyMcpMetadata(issuer, { fetchImpl: deps.fetchImpl });
      if (live.ok) {
        push(true,
          `Fabric deployment (${host}): ${binding.detail}; the /mcp OAuth surface already passes self-verify on ${issuer}. ` +
            `If this run changed a secret value (a new IdP client secret, for example), restart the instance so its process picks the new value up.`,
        );
        currentStep = "self-verify";
        push(true, live.detail);
        const resource = `${issuer}/mcp`;
        return {
          ok: true,
          dryRun: false,
          steps,
          issuer,
          resource,
          pasteBlock: buildClaudePasteBlock(resource),
          secretsMechanism: secretsResult.mechanism,
          secretsPath: secretsResult.path,
          callbackUrl,
        };
      }
      // A request that failed read nothing: it shows neither that the
      // environment is wrong nor that a restart is needed, so it gets checks
      // to run instead of the activation instructions (flair#2116).
      const msg = live.unreachable
        ? [
          `Fabric deployment detected (${host}); the public issuer could not be reached (${live.detail}).`,
          `A failed request does not show that the environment is wrong or that a restart is needed.`,
          `Check first that the host in that URL resolves in DNS, that this machine can reach it over HTTPS, and that the instance is running in Fabric.`,
          `Then re-run \`flair mcp enable\` with the same options plus --confirm-secrets-applied: this step checks ${issuer} again, passes once self-verify does, and says what to apply if the surface answers but is not active.`,
        ].join(" ")
        : [
        `Fabric deployment detected (${host}); self-verify on ${issuer} has not passed yet (${live.detail}).`,
        `The @harperfast/oauth block ships in config.yaml with mcp.enabled: \${FLAIR_MCP_OAUTH} (env-referenced, flair#1152) — no config edit is needed.`,
        secretsPushed
          ? `To activate: the secrets were pushed to the instance above (FLAIR_MCP_OAUTH=true among them); restart the instance.`
          : `To activate: apply the staged secrets (FLAIR_MCP_OAUTH=true among them) to the instance's environment (Fabric env), then restart the instance.`,
        `Deploys can no longer revert the choice — it lives in the environment, not the packed file.`,
        `Then re-run \`flair mcp enable\` with the same options plus --confirm-secrets-applied: this step checks ${issuer} again and passes once self-verify does.`,
      ].join(" ");
      push(false, msg);
      return {
        ok: false,
        dryRun,
        steps,
        failedStep: "fabric-operator-deploy",
        issuer,
        resource: `${issuer}/mcp`,
        secretsMechanism: secretsResult.mechanism,
        secretsPath: secretsResult.path,
        callbackUrl,
      };
    }

    // ── Standalone (non-Fabric): update local config + restart ────────────
    currentStep = "local-config-update";
    const localConfigResult = updateLocalConfigMcpEnabled(true, params.localConfigPath);
    if (!localConfigResult.ok) {
      // flair#2193: stop BEFORE the restart. The mcp.enabled update was not
      // confirmed (the file may have changed), and the metadata checks below
      // could still pass and report success.
      const retry = params.localConfigPath
        ? "retry the call with the same explicit path"
        : "re-run `flair mcp enable`";
      push(false, `${localConfigResult.detail} This command did not restart the instance. Fix the cause above, then ${retry}.`);
      return {
        ok: false,
        dryRun,
        steps,
        failedStep: "local-config-update",
        issuer,
        resource: `${issuer}/mcp`,
        secretsMechanism: secretsResult.mechanism,
        secretsPath: secretsResult.path,
        callbackUrl,
      };
    }
    push(true, localConfigResult.detail);

    // flair#2113: ensure --cimd-allowed-hosts (written unless the file already
    // holds that exact list) and read it back. A failure here stops the flow
    // before the restart.
    let writtenCimd: { hosts: string[]; path: string } | undefined;
    if (cimdAllowedHosts) {
      const written = updateLocalConfigCimdAllowedHosts(cimdAllowedHosts, params.localConfigPath);
      if (!written.ok || !written.readBack || !written.path) {
        push(false,
          `--cimd-allowed-hosts change could not be confirmed: ${written.detail}. The config.yaml may have changed, ` +
            `and this command did not restart the instance. ` +
            `Fix that, or set ${CIMD_ALLOWED_HOSTS_CONFIG_KEY} by hand, then re-run \`flair mcp enable\`.`,
        );
        return {
          ok: false,
          dryRun,
          steps,
          failedStep: "local-config-update",
          issuer,
          resource: `${issuer}/mcp`,
          secretsMechanism: secretsResult.mechanism,
          secretsPath: secretsResult.path,
          callbackUrl,
        };
      }
      writtenCimd = { hosts: written.readBack, path: written.path };
      push(true, written.detail);
    }

    // ── Restart ───────────────────────────────────────────────────────────
    currentStep = "restart";
    const preDiscriminator = await captureBootDiscriminator(
       params.instance, params.adminUser, params.adminPass,
         { fetchImpl: deps.fetchImpl },
       );

    await triggerRemoteRestart(
      params.instance, params.adminUser, params.adminPass,
      { fetchImpl: deps.fetchImpl },
    );
    push(true, `restart triggered against ${params.instance}`);

    // ── Verify the process actually restarted (flair#1120) ──────────────────
    currentStep = "verify-restart";
    const postDiscriminator = await waitForOpsApi(
       resolveOpsUrl(params.instance),
       basicAuthHeader(params.adminUser, params.adminPass),
       preDiscriminator.pid,
         {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.waitForOpsApiTimeoutMs,
          pollMs: deps.waitForOpsApiPollMs,
         },
       );
    push(true, `process restarted: pid changed ${preDiscriminator.pid} -> ${postDiscriminator.pid}`);

    // ── Match the target's issuer, then self-verify the public origin ────────
    currentStep = "self-verify";
    const binding = await verifyTargetIssuer(params.instance, issuer, { fetchImpl: deps.fetchImpl });
    if (!binding.ok) {
      push(false, binding.detail);
      return { ok: false, dryRun, refused: { message: binding.detail }, steps, failedStep: "self-verify", issuer, resource: `${issuer}/mcp`, secretsMechanism: secretsResult.mechanism, secretsPath: secretsResult.path, callbackUrl, cimdAllowedHosts: writtenCimd?.hosts, cimdAllowedHostsConfigPath: writtenCimd?.path };
    }
    const verify = await selfVerifyMcpMetadata(issuer, { fetchImpl: deps.fetchImpl });
    if (!verify.ok) {
      push(false, `${verify.detail} — re-run \`flair mcp status\` to check current state, or \`flair mcp enable\` to retry.`);
      return {
        ok: false,
        dryRun,
        steps,
        failedStep: "self-verify",
        issuer,
        resource: `${issuer}/mcp`,
        cimdAllowedHosts: writtenCimd?.hosts,
        cimdAllowedHostsConfigPath: writtenCimd?.path,
      };
    }
    push(true, `${binding.detail}; ${verify.detail}`);

    const resource = `${issuer}/mcp`;
    return {
      ok: true,
      dryRun: false,
      steps,
      issuer,
      resource,
      pasteBlock: buildClaudePasteBlock(resource),
      secretsMechanism: secretsResult.mechanism,
      secretsPath: secretsResult.path,
      callbackUrl,
      cimdAllowedHosts: writtenCimd?.hosts,
      cimdAllowedHostsConfigPath: writtenCimd?.path,
    };
  } catch (err: any) {
    // flair#1087: blame the step that was RUNNING, never the last one that
    // succeeded. This read steps[steps.length - 1] — the last COMPLETED step —
    // so a throw inside identity-mapping was reported against
    // secrets-provisioning, which had just succeeded. An operator saw:
    //
    //     ✓ secrets-provisioning   ...apply these 5 vars in Fabric Studio, then re-run
    //     ✗ secrets-provisioning   unexpected error: Identity mapping: ...
    //
    // Two results for one step, and the ✓ instructs several minutes of manual
    // work in a web UI that the ✗ makes pointless. Read in order, you do the
    // work first.
    // No fallback step NAME: currentStep is initialised to the first step, so
    // there is no undefined case to invent a name for. A fallback here
    // would attribute a throw to a step chosen for being a plausible default —
    // the same misattribution this handler exists to prevent, one layer down.
    push(false, `unexpected error: ${err?.message ?? err}`);
    return { ok: false, dryRun, steps, failedStep: currentStep };
  }
}

// ─── flair mcp disable ────────────────────────────────────────────────────────

export interface DisableMcpParams {
  instance: string;
  adminUser: string;
  adminPass: string;
  confirmFlagOff?: boolean;
}

export interface DisableMcpDeps {
  fetchImpl?: typeof fetch;
  confirmPrompt?: (message: string) => Promise<boolean>;
}

export interface DisableMcpResult {
  ok: boolean;
  detail: string;
}

/**
 * Flag off + restart = byte-identical boot, per the Model-2 contract
 * (resources/mcp-oauth.ts: the route is registered ONLY when
 * `FLAIR_MCP_OAUTH` is truthy; when off, the module does nothing at load).
 * `FLAIR_MCP_OAUTH` is a process env var (never YAML config —
 * resources/mcp-oauth-flag.ts), so `disable` cannot flip it remotely by
 * itself; it requires the same operator confirmation `enable` requires
 * before it calls `restart`. The `@harperfast/oauth` config block written by
 * `enable` is deliberately left in place — it's inert whenever the flag is
 * off, so there is nothing to "undo" there.
 */
export async function disableMcp(params: DisableMcpParams, deps: DisableMcpDeps = {}): Promise<DisableMcpResult> {
  let confirmed = Boolean(params.confirmFlagOff);
  if (!confirmed && deps.confirmPrompt) {
    confirmed = await deps.confirmPrompt(
      `Have you unset FLAIR_MCP_OAUTH (or set it to 0) in ${params.instance}'s process environment?`,
    );
  }
  if (!confirmed) {
    return {
      ok: false,
      detail:
        `Unset FLAIR_MCP_OAUTH (or set it to 0) via the same mechanism \`flair mcp enable\` used to set it, ` +
        `then re-run \`flair mcp disable --confirm-flag-off\` to restart.`,
    };
  }

  try {
    await triggerRemoteRestart(params.instance, params.adminUser, params.adminPass, { fetchImpl: deps.fetchImpl });
  } catch (err: any) {
    return { ok: false, detail: `restart failed: ${err?.message ?? err}` };
  }
  return { ok: true, detail: `restart requested for ${params.instance}` };
}

// ─── flair mcp status ─────────────────────────────────────────────────────────

export interface McpStatusParams {
  instance: string;
}

export interface McpStatusDeps {
  fetchImpl?: typeof fetch;
  /** Reads the local machine-client manifest count — reuses the EXISTING
   *  `flair mcp list` machinery (src/cli.ts's `readMcpClientManifest`)
   *  rather than a new server call, per Kern's note that `status`/`list`
   *  must agree on what a "client" is. */
  countMachineClients?: () => number;
}

export interface McpStatusResult {
  instance: string;
  enabled: boolean;
  metadataReachable: boolean;
  issuer?: string;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  /** flair#756: does the live metadata endpoint advertise CIMD support
   *  (allowedHosts config presence, from the operator's perspective — the
   *  only signal `status` can see WITHOUT admin credentials; see
   *  `selfVerifyMcpMetadata`'s doc comment for the exact check)? */
  cimdSupported?: boolean;
  detail: string;
  machineClientCount?: number;
}

/**
 * Reports a live public-metadata check (not a stale local marker): hits the
 * same well-known metadata endpoint `enable`'s self-verify step checks. An expected issuer,
 * exact MCP token endpoint, CIMD advertisement and, when present, a string
 * `registration_endpoint` verify the public metadata;
 * they do not prove that the token route or `/mcp` is usable. `status` reports
 * the live metadata check's result rather than guessing from local files.
 */
export async function mcpStatus(params: McpStatusParams, deps: McpStatusDeps = {}): Promise<McpStatusResult> {
  const verify = await selfVerifyMcpMetadata(params.instance, { fetchImpl: deps.fetchImpl });
  const machineClientCount = deps.countMachineClients?.();

  return {
    instance: params.instance,
    enabled: verify.ok,
    metadataReachable: verify.ok,
    issuer: verify.issuer,
    registrationEndpoint: verify.registrationEndpoint,
    tokenEndpoint: verify.tokenEndpoint,
    cimdSupported: verify.cimdSupported,
    detail: verify.detail,
    machineClientCount,
  };
}
