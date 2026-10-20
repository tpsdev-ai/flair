/**
 * rem.ts — `flair rem` command group (flair#1623 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration, action handlers, and group-specific
 * inline helpers (candidate-line format, reflect-error classify, pause
 * sentinel). Shared CLI helpers (api, credential flags, port resolve, …)
 * stay in cli.ts and are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { encodeRecordId } from "../lib/record-id-path.js";
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import { dirname, resolve } from "node:path";
import * as render from "../render.js";
import { isLocalBase, resolveAdminUser, resolveLocalAdminPass, resolveAdminPassFromSources, AdminPassSourceError, ADMIN_PASS_FILE_FLAG, ADMIN_PASS_FILE_HELP, ADMIN_PASS_FLAG, ADMIN_PASS_HELP } from "../lib/auth-resolve.js";
import type { OpsSearch } from "../rem/restore.js";
import { proveLocalInstancePair, type LocalInstancePairDeps } from "../lib/local-instance-pair.js";
import { decideInstanceAnswer, readableInstanceRows, INSTANCE_ROWS_SQL, type InstanceIdentityRow } from "../lib/instance-identity-row.js";
import {
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  validateHumanReviewerId,
  structuralImbalance,
  hasTerminalPunctuation,
  type SourceMemoryFetch,
} from "../rem/promote-policy.js";
import { resolveHome } from "../lib/home.js";

export {
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  derivePromotedVisibility,
  validateHumanReviewerId,
  isMachineReviewerId,
  ADK_SCOPE_TAG_PREFIX,
  CONTINUITY_SCOPE_TAG_PREFIX,
  MACHINE_REVIEWER_PREFIX,
  MACHINE_REVIEWER_ADK_AUTO_PROMOTE,
} from "../rem/promote-policy.js";
export type { SourceMemoryFetch, PromotedTagsDecision } from "../rem/promote-policy.js";

export type RemCli = {
  api: (...args: any[]) => Promise<any>;
  resolveOpsPort: (opts: { opsPort?: string | number; port?: string | number }) => number;
  applyAdminPassFile: (opts: { adminPass?: string; adminPassFile?: string }) => void;
  addSharedCredentialOptions: (cmd: Command) => Command;
  readPortFromConfig: () => number | null;
  resolveHttpPort: (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create") => number;
  resolveOpsUrlFromTarget: (target: string) => string;
  resolveAgentHomeTarget: (opts: { port?: string | number; opsPort?: string | number; dataDir?: string }) => { httpPort: number; opsPort: number };
  INSTANCE_TARGET_REMEDY: string;
  humanBytes: (n: number) => string;
  relativeTime: (iso: string | null | undefined) => string;
  DEFAULT_PORT: number;
  pkgVersion: string;
};

let cli: RemCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: RemCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveOpsPort(opts: { opsPort?: string | number; port?: string | number }): number {
  return cli.resolveOpsPort(opts);
}
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  cli.applyAdminPassFile(opts);
}
function addSharedCredentialOptions(cmd: Command): Command {
  return cli.addSharedCredentialOptions(cmd);
}
function readPortFromConfig(): number | null {
  return cli.readPortFromConfig();
}
function resolveHttpPort(opts: { port?: string | number; dataDir?: string }, mode: "address" | "create" = "address"): number {
  return cli.resolveHttpPort(opts, mode);
}
function deriveOpsUrl(target: string): string {
  return cli.resolveOpsUrlFromTarget(target);
}
function resolvePair(opts: { port?: string | number; opsPort?: string | number }): { httpPort: number; opsPort: number } {
  return cli.resolveAgentHomeTarget(opts);
}
function humanBytes(n: number): string {
  return cli.humanBytes(n);
}
function relativeTime(iso: string | null | undefined): string {
  return cli.relativeTime(iso);
}

/**
 * Build the admin-authed ops-API `search_by_conditions` helper shared by the
 * rem commands. `search_by_conditions` is an ops-API operation, not a Harper
 * REST route — Harper's REST dispatcher maps `POST /<table>` to
 * `resource.post()` and never routes a URL suffix, so `/MemoryCandidate/
 * search_by_conditions` 405s. Both the nightly pending-candidate count and
 * the restore-time candidate cleanup must reach the ops port this way.
 * `opsUrl` (restore's operations URL) takes precedence over `opsPort` (a
 * loopback port). A redirect is refused, so the admin credential goes only to
 * the URL built here. `fetchImpl` is injectable for tests.
 */
export function buildOpsSearch(
  opts: { opsPort?: number; opsUrl?: string; adminUser?: string; adminPass: string },
  fetchImpl: typeof fetch = fetch,
): OpsSearch {
  const root = (opts.opsUrl ?? `http://127.0.0.1:${opts.opsPort}`).replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${opts.adminPass}`).toString("base64")}`;
  return async (table, conditions, getAttributes) => {
    const res = await fetchImpl(`${root}/`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ operation: "search_by_conditions", schema: "flair", table, operator: "and", conditions, get_attributes: getAttributes }),
    });
    if (!res.ok) throw new Error(`ops API failed (${res.status})`);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new Error("ops API returned invalid JSON");
    }
    if (Array.isArray(raw)) return raw;
    const results = (raw as { results?: unknown } | null)?.results;
    // flair#2680: an unrecognised body is an error, not zero rows.
    if (Array.isArray(results)) return results;
    throw new Error("ops API returned an unexpected response shape");
  };
}

/**
 * The two endpoints a restore uses (flair#2708): the base URL its reads and
 * writes go to and the operations URL its candidate listing goes to, on the
 * same host (for a loopback target, both are on 127.0.0.1, whichever loopback
 * name the target URL uses). Resolving them proves nothing about the instance behind them;
 * {@link establishRestorePair} is the preflight check.
 */
export interface RestoreTarget {
  /** Base URL of the restore's reads and writes (on 127.0.0.1 for a loopback target). */
  baseUrl: string;
  /** Operations API URL of the candidate listing. */
  opsUrl: string;
  /** The target's HTTP port: the URL's port, or 80/443 for a URL without one. */
  httpPort: number;
  /** The operations port in `opsUrl`. */
  opsPort: number;
  /**
   * Whether the target URL names a loopback host: 127.0.0.1, localhost or ::1
   * (written `[::1]` in a URL), or no FLAIR_URL is set. Only a loopback URL is
   * compared with this host's configured pair and checked against the OS
   * listener table; any other URL, including one with this machine's LAN
   * address, takes the identity check ({@link establishRestorePair}).
   */
  loopback: boolean;
}

/** The environment {@link resolveRestoreTarget} reads. */
export interface RestoreTargetEnv {
  /** FLAIR_URL: the target's base URL; unset means the local instance. */
  flairUrl?: string;
  /** FLAIR_OPS_PORT: an explicit operations port for the target. */
  opsPort?: string;
  /**
   * FLAIR_OPS_TARGET: an operations endpoint other commands use. It does not
   * select restore's listing endpoint; restore compares it with the one it
   * resolves, and refuses unless the two are the same root URL.
   */
  opsTarget?: string;
}

/** Injectable seams for {@link resolveRestoreTarget}. */
export interface RestoreTargetDeps {
  /** The paired resolver (`resolveAgentHomeTarget`, flair#2474). */
  resolvePair?: (opts: { port?: string | number; opsPort?: string | number }) => { httpPort: number; opsPort: number };
  /** The conventional operations URL of a target URL (`resolveOpsUrlFromTarget`). Reads no environment. */
  deriveOpsUrl?: (target: string) => string;
}

/**
 * A URL as restore prints it: scheme, host, port and path. User info, a query
 * and a fragment are never printed. A value that is not an http(s) URL prints
 * as `placeholder`: its parts are hidden, so untrusted input is not echoed.
 */
export function displayRestoreUrl(raw: string, placeholder: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return placeholder;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return placeholder;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Whether a target URL names a loopback host: 127.0.0.1, localhost, or ::1 (`[::1]` in a URL). */
function isLoopbackTargetUrl(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
}

/** A URL's port, or its scheme's default port when the URL names none. */
function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

/** The paired resolver's message without its stamp-home remedy, which names flags restore does not have. */
function withoutPairRemedy(message: string): string {
  const remedy = cli?.INSTANCE_TARGET_REMEDY;
  return remedy && message.endsWith(remedy) ? message.slice(0, -remedy.length).trimEnd() : message;
}

/**
 * Resolves the two endpoints a restore uses (flair#2708): where its writes go
 * and where its candidate listing goes. Nothing here sends a request or shows
 * that the two reach one instance; {@link establishRestorePair} is the
 * preflight check that runs before any listing, delete or write.
 *
 * - With no FLAIR_URL, the target is the local instance: its port pair comes
 *   from the paired resolver (`resolveAgentHomeTarget`, flair#2474), which
 *   refuses FLAIR_OPS_PORT when no complete configured pair can show which
 *   HTTP port it belongs with.
 * - With FLAIR_URL, the writes go to that URL. Its HTTP port is the URL's port,
 *   or 80/443 when it names none. The operations port is FLAIR_OPS_PORT when
 *   set, else the conventional derivation from the target URL
 *   (`resolveOpsUrlFromTarget`); a target with no derivable operations port
 *   and no FLAIR_OPS_PORT is refused. For a loopback URL (127.0.0.1,
 *   localhost or [::1]) the operations URL is http://127.0.0.1:<operations
 *   port>, the endpoint the OS listener check proves, and the two ports also go
 *   through the paired resolver, which refuses a pair that conflicts with this
 *   host's configured pair. Any other URL, including one with this machine's
 *   LAN address, gets its operations URL on the target's host and is not
 *   compared with this host's configuration.
 * - A FLAIR_URL carrying user info, a query or a fragment is refused, and the
 *   message prints none of their values.
 * - FLAIR_OPS_TARGET does not select the listing endpoint. When it is set to
 *   anything but exactly the root URL of the operations API resolved here
 *   (compared as normalized root URLs, with no user info, query, fragment or
 *   path), restore refuses; a value of only whitespace is refused too. An
 *   empty value counts as unset, as FLAIR_URL and FLAIR_OPS_PORT do here.
 */
export function resolveRestoreTarget(env: RestoreTargetEnv, deps: RestoreTargetDeps = {}): RestoreTarget {
  const resolvePairImpl = deps.resolvePair ?? resolvePair;
  const deriveOpsUrlImpl = deps.deriveOpsUrl ?? deriveOpsUrl;
  const opsPortEnv = env.opsPort;
  const declared = opsPortEnv === undefined || opsPortEnv === "" ? null : Number(opsPortEnv);
  if (declared !== null && (!Number.isInteger(declared) || declared < 1 || declared > 65535)) {
    throw new Error(
      `invalid FLAIR_OPS_PORT ${JSON.stringify(opsPortEnv)}. Set it to the restore target instance's operations port (1-65535), or unset it.`,
    );
  }

  let target: RestoreTarget;
  if (!env.flairUrl) {
    let pair: { httpPort: number; opsPort: number };
    try {
      pair = resolvePairImpl(declared === null ? {} : { opsPort: declared });
    } catch (err: any) {
      throw new Error(
        `the local restore target could not be paired: ${withoutPairRemedy(err?.message ?? String(err))} `
          + "Set FLAIR_URL to the instance's base URL and FLAIR_OPS_PORT to its operations port, or unset FLAIR_OPS_PORT to use the configured pair.",
      );
    }
    target = {
      baseUrl: `http://127.0.0.1:${pair.httpPort}`,
      opsUrl: `http://127.0.0.1:${pair.opsPort}`,
      httpPort: pair.httpPort,
      opsPort: pair.opsPort,
      loopback: true,
    };
  } else {
    target = resolveUrlRestoreTarget(env.flairUrl, declared, resolvePairImpl, deriveOpsUrlImpl);
  }
  refuseOtherOpsTarget(env.opsTarget, target);
  return target;
}

function resolveUrlRestoreTarget(
  raw: string,
  declared: number | null,
  resolvePairImpl: NonNullable<RestoreTargetDeps["resolvePair"]>,
  deriveOpsUrlImpl: NonNullable<RestoreTargetDeps["deriveOpsUrl"]>,
): RestoreTarget {
  const example = "for example http://127.0.0.1:19926";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      `FLAIR_URL is not a parseable URL, so restore has no instance to address. Set FLAIR_URL to the instance's base URL (${example}), or unset it to restore the local instance.`,
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `FLAIR_URL is not an http:// or https:// URL, so restore has no instance to address. Set FLAIR_URL to the instance's base URL (${example}), or unset it to restore the local instance.`,
    );
  }
  const shown = displayRestoreUrl(raw, "<FLAIR_URL>");
  const carried: string[] = [];
  if (u.username || u.password) carried.push("user info");
  if (u.search || raw.includes("?")) carried.push("a query");
  if (u.hash || raw.includes("#")) carried.push("a fragment");
  if (carried.length > 0) {
    throw new Error(
      `FLAIR_URL ${shown} carries ${carried.join(" and ")}. Restore refuses a target URL that carries user info, a query or a fragment, and prints none of their values. `
        + "Set FLAIR_URL to the instance's base URL (scheme, host and port), and pass the admin credential with --admin-pass-file or FLAIR_ADMIN_PASS.",
    );
  }

  const base = shown;
  const httpPort = effectivePort(u);
  let opsPort: number;
  if (declared !== null) {
    opsPort = declared;
  } else {
    let derived: URL;
    try {
      derived = new URL(deriveOpsUrlImpl(base));
    } catch (err: any) {
      throw new Error(
        `restore target ${shown} has no derivable operations API URL (${err?.message ?? String(err)}). `
          + "Restore lists candidates through the operations API on its target's host, and derives that API's port from FLAIR_URL when FLAIR_OPS_PORT is unset. "
          + "Set FLAIR_OPS_PORT to that instance's operations port, or set FLAIR_URL to the instance's base URL with its HTTP port.",
      );
    }
    opsPort = effectivePort(derived);
  }

  const loopback = isLoopbackTargetUrl(u);
  if (loopback) {
    try {
      resolvePairImpl({ port: httpPort, opsPort });
    } catch (err: any) {
      throw new Error(
        `restore target ${shown} could not be paired with operations port ${opsPort}`
          + `${declared === null ? " (derived from FLAIR_URL)" : " (FLAIR_OPS_PORT)"}: ${withoutPairRemedy(err?.message ?? String(err))} `
          + `Set FLAIR_OPS_PORT to the operations port of the instance serving HTTP port ${httpPort}, or unset it to derive the operations port from FLAIR_URL.`,
      );
    }
    // Both endpoints on 127.0.0.1, the address the OS listener check proves
    // (src/lib/local-instance-pair.ts), whichever loopback name the URL uses.
    const pinned = new URL(base);
    pinned.hostname = "127.0.0.1";
    return { baseUrl: pinned.toString().replace(/\/$/, ""), opsUrl: `http://127.0.0.1:${opsPort}`, httpPort, opsPort, loopback };
  }

  const ops = new URL(base);
  ops.port = String(opsPort);
  ops.pathname = "";
  return { baseUrl: base, opsUrl: ops.toString().replace(/\/$/, ""), httpPort, opsPort, loopback };
}

/** `scheme://host:port/` with the scheme's default port written out, for comparing two root URLs. */
function normalizedRoot(u: URL): string {
  return `${u.protocol}//${u.hostname}:${effectivePort(u)}/`;
}

/**
 * Refuses a FLAIR_OPS_TARGET that is not exactly the root URL of `target`'s
 * operations API. The two are compared as normalized root URLs (scheme, host
 * and port, with the default port written out). User info, a query, a fragment
 * or a path other than `/` refuses even on the same scheme, host and port, and
 * the message prints only the override's scheme, host and port. A value of
 * only whitespace is set, not unset, and is refused; an empty value counts as
 * unset. The setting does not select restore's listing endpoint, which is
 * always the one resolved from restore's own target; when the two are the same
 * root URL, the listing goes to that endpoint.
 */
function refuseOtherOpsTarget(opsTargetEnv: string | undefined, target: RestoreTarget): void {
  if (opsTargetEnv === undefined || opsTargetEnv === "") return;
  const raw = opsTargetEnv.trim();
  if (!raw) {
    throw new Error(
      `FLAIR_OPS_TARGET is set but holds only whitespace, so it names no operations endpoint to compare with the one restore lists candidates on (${target.opsUrl}); `
        + `nothing was sent. Unset FLAIR_OPS_TARGET for this command, or set it to ${target.opsUrl}.`,
    );
  }
  let named: URL | null;
  try {
    named = new URL(raw);
  } catch {
    named = null;
  }
  const httpLike = named !== null && (named.protocol === "http:" || named.protocol === "https:");
  const shown = httpLike ? `${named!.protocol}//${named!.host}` : "<not an http(s) URL>";
  const remedy = `Unset FLAIR_OPS_TARGET for this command, or set it to ${target.opsUrl}.`;
  if (named === null || !httpLike) {
    throw new Error(
      `FLAIR_OPS_TARGET is not an http(s) URL, so it cannot be the operations API restore lists candidates on (${target.opsUrl}); nothing was sent to it. ${remedy}`,
    );
  }
  const carried: string[] = [];
  if (named.username || named.password) carried.push("user info");
  if (named.search || raw.includes("?")) carried.push("a query");
  if (named.hash || raw.includes("#")) carried.push("a fragment");
  if (named.pathname !== "/") carried.push("a path other than /");
  if (carried.length > 0) {
    throw new Error(
      `FLAIR_OPS_TARGET ${shown} carries ${carried.join(" and ")}. Restore accepts FLAIR_OPS_TARGET only when it is exactly the root URL `
        + `of the operations API it lists candidates on (${target.opsUrl}), prints none of its user info, path, query or fragment, and sent nothing to it. ${remedy}`,
    );
  }
  if (normalizedRoot(named) !== normalizedRoot(new URL(target.opsUrl))) {
    throw new Error(
      `FLAIR_OPS_TARGET names the operations endpoint ${shown}, but restore lists candidates only on the operations API it resolves `
        + `from its own target ${target.baseUrl}, which is ${target.opsUrl}; nothing was sent to FLAIR_OPS_TARGET. ${remedy}`,
    );
  }
}

/** Injectable seams for {@link establishRestorePair}: its fetch and the OS reads of the loopback check. */
export type RestorePairDeps = LocalInstancePairDeps;

/** The remedy for a refused admin credential. */
const RESTORE_CREDENTIAL_REMEDY =
  "Check that the admin credential restore uses (--admin-pass, --admin-pass-file or FLAIR_ADMIN_PASS) is the target instance's.";

/** The remedy for a loopback pair check that answered without naming one. */
function restorePairRemedy(target: RestoreTarget, status: number | null): string {
  if (status === 401 || status === 403) return RESTORE_CREDENTIAL_REMEDY;
  return `Set FLAIR_OPS_PORT to the operations port of the instance serving ${target.baseUrl}, or unset it; `
    + "if that instance's configuration records ports it does not serve, correct it and restart the instance.";
}

/** What one endpoint's `flair.Instance` read established: exactly one id, or why not. */
export type RestoreIdentityRead =
  | { kind: "one"; id: string }
  | { kind: "not-proven"; detail: string; status?: number; noRow?: true };

/** The remote pair decision: proven (one equal id on both sides), two different ids, or not proven. */
export type RemoteRestorePairVerdict =
  | { kind: "proven"; id: string }
  | { kind: "different" }
  | { kind: "not-proven"; reads: Array<Extract<RestoreIdentityRead, { kind: "not-proven" }>> };

/**
 * The remote pair rule (flair#2708): proven only when the HTTP endpoint and
 * the operations endpoint each report exactly one `flair.Instance` row and
 * the two ids are equal. Any other read on either side (no row, several rows,
 * an error status, a redirect, an unreadable body or no answer) is not proof,
 * whatever the other side reports.
 */
export function decideRemoteRestorePair(http: RestoreIdentityRead, ops: RestoreIdentityRead): RemoteRestorePairVerdict {
  if (http.kind === "one" && ops.kind === "one") {
    return http.id === ops.id ? { kind: "proven", id: http.id } : { kind: "different" };
  }
  return { kind: "not-proven", reads: [http, ops].filter((r): r is Extract<RestoreIdentityRead, { kind: "not-proven" }> => r.kind === "not-proven") };
}

/** A fetch failure's code or name, never its message (which can carry the URL). */
function fetchFailureLabel(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
  if (typeof e?.cause?.code === "string" && e.cause.code) return e.cause.code;
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.name === "string" && e.name) return e.name;
  return "request failed";
}

/**
 * One endpoint's `flair.Instance` identity, read with redirects handed back
 * rather than followed. A redirect, an error status, a body that is not a row
 * list, a row without a usable id, no row or several rows is not an identity;
 * the shared one-row rule (`decideInstanceAnswer`) decides the rest.
 */
async function readRestoreIdentity(label: string, request: () => Promise<Response>): Promise<RestoreIdentityRead> {
  let res: Response;
  try {
    res = await request();
  } catch (err) {
    return { kind: "not-proven", detail: `${label} got no answer (${fetchFailureLabel(err)})` };
  }
  if (res.status >= 300 && res.status < 400) {
    return { kind: "not-proven", detail: `${label} answered with a redirect (HTTP ${res.status}), which restore does not follow`, status: res.status };
  }
  if (!res.ok) return { kind: "not-proven", detail: `${label} answered HTTP ${res.status}`, status: res.status };
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { kind: "not-proven", detail: `${label} answered a body that is not JSON` };
  }
  const entries = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
  if (entries === null) return { kind: "not-proven", detail: `${label} answered a body that is not a row list` };
  let rows: InstanceIdentityRow[];
  try {
    rows = readableInstanceRows(entries);
  } catch {
    return { kind: "not-proven", detail: `${label} answered a row without a usable id` };
  }
  const decision = decideInstanceAnswer(rows);
  if (decision.kind === "answer") return { kind: "one", id: decision.row.id };
  if (decision.kind === "refuse-multiple") {
    return { kind: "not-proven", detail: `${label} reports ${decision.rows.length} flair.Instance rows, not one` };
  }
  return { kind: "not-proven", detail: `${label} reports no flair.Instance row`, noRow: true };
}

/**
 * The preflight pair check restore runs before it lists, deletes or writes
 * anything (flair#2708). Returns when the check passes; otherwise throws an
 * Error naming what was not proven and the remedy. What it establishes:
 *
 * - Loopback URL (127.0.0.1, localhost or [::1], or no FLAIR_URL): the check
 *   the local delete paths use
 *   (`proveLocalInstancePair`, src/lib/local-instance-pair.ts). The operations
 *   endpoint's own configuration records that operations port and an HTTP
 *   port, and the OS listener table shows one process with a Harper command
 *   line listening on both ports, with the same pid and start time on two
 *   reads. Restore then requires that HTTP port to be the target's.
 * - Any other URL, including one with this machine's LAN address: the HTTP
 *   endpoint (`GET /Instance/`) and the operations endpoint (an SQL read of
 *   `flair.Instance`) must each report exactly one Instance row, with the same
 *   id ({@link decideRemoteRestorePair}). Matching port numbers in a
 *   configuration are not accepted as proof. A missing, multiple or
 *   unreadable identity on either side refuses, and so does a redirect.
 *
 * It is a preflight: it says nothing about a process that takes over either
 * endpoint after it returns. No request it sends follows a redirect. For a
 * loopback URL its requests go to the operations port on 127.0.0.1, the
 * endpoint the OS listener check proves, whichever loopback name (127.0.0.1,
 * localhost or [::1]) the target URL uses. For any other URL they go to the
 * target URL's host: its `/Instance/` and the operations URL built on that
 * host. The admin credential is sent with each of them.
 */
export async function establishRestorePair(
  target: RestoreTarget,
  admin: { user: string; pass: string },
  deps: RestorePairDeps = {},
): Promise<void> {
  const authorization = `Basic ${Buffer.from(`${admin.user}:${admin.pass}`).toString("base64")}`;
  const baseFetch = deps.fetchImpl ?? fetch;
  // Never "follow": a read that wants the 3xx itself asks for "manual".
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    baseFetch(input, { ...init, redirect: init?.redirect === "manual" ? "manual" : "error" })) as typeof fetch;
  const nothingSent = "nothing was listed, deleted or written";

  if (target.loopback) {
    const proof = await proveLocalInstancePair(target.opsPort, authorization, { ...deps, fetchImpl });
    if (proof.kind === "unproven") {
      throw new Error(
        `operations port ${target.opsPort} is not proven to pair with restore target ${target.baseUrl} (${proof.detail}); ${nothingSent}. `
          + (proof.remedy ?? restorePairRemedy(target, proof.status)),
      );
    }
    if (proof.httpPort !== target.httpPort) {
      throw new Error(
        `operations port ${target.opsPort} belongs to the instance serving HTTP port ${proof.httpPort}, not restore target ${target.baseUrl} (HTTP port ${target.httpPort}); ${nothingSent}. `
          + `Set FLAIR_OPS_PORT to the operations port of the instance serving HTTP port ${target.httpPort}, or unset it to derive the operations port from the target.`,
      );
    }
    return;
  }

  const timeout = () => AbortSignal.timeout(10_000);
  const [httpRead, opsRead] = await Promise.all([
    readRestoreIdentity("the HTTP endpoint's GET /Instance/", () =>
      fetchImpl(`${target.baseUrl}/Instance/`, { headers: { Authorization: authorization }, signal: timeout(), redirect: "manual" })),
    readRestoreIdentity("the operations endpoint's Instance read", () =>
      fetchImpl(`${target.opsUrl}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify({ operation: "sql", sql: INSTANCE_ROWS_SQL }),
        signal: timeout(),
        redirect: "manual",
      })),
  ]);
  const verdict = decideRemoteRestorePair(httpRead, opsRead);
  if (verdict.kind === "proven") return;
  const hostRemedy =
    "On the instance's own host, unset FLAIR_URL or set it to the instance's loopback URL (127.0.0.1, localhost or [::1]); the pair check then reads the OS listener table instead.";
  if (verdict.kind === "different") {
    throw new Error(
      `restore target ${target.baseUrl} and the operations API at ${target.opsUrl} report different flair.Instance ids, so restore treats them as two instances; ${nothingSent}. `
        + `Set FLAIR_OPS_PORT to the operations port of the instance serving ${target.baseUrl}, or unset it. ${hostRemedy}`,
    );
  }
  const statuses = verdict.reads.map((r) => r.status);
  const remedy = statuses.includes(401) || statuses.includes(403)
    ? RESTORE_CREDENTIAL_REMEDY
    : verdict.reads.some((r) => r.noRow)
      ? `${hostRemedy} Or give the instance its Instance row: an authorized, successful GET /FederationInstance creates one when there is none `
        + "(it needs the admin credential; `flair federation status --target <its URL>` sends it). That request can refuse, for example when the "
        + "Instance table cannot be read or the row cannot be created; resolve any refusal it returns first."
      : hostRemedy;
  throw new Error(
    `restore target ${target.baseUrl} is not proven to share one identity with the operations API at ${target.opsUrl}: ${verdict.reads.map((r) => r.detail).join("; ")}. `
      + `For a target URL that is not a loopback URL, restore requires both endpoints to report exactly one flair.Instance row with the same id; ${nothingSent}. ${remedy}`,
  );
}

// ─── flair rem rapid — pure helpers ──────────────────────────────────────────
// Extracted for testability, same pattern as validatePromoteOpts /
// decideCandidateAction above: the action callback below spawns api() +
// process.exit, which makes it high-effort/low-value to drive directly;
// these two functions are the actual decision logic.

/** One staged-candidate summary line: `[id] claim, truncated to ~80 chars`. */
export function formatCandidateLine(candidate: { id?: string; claim?: string }, maxClaimLen = 80): string {
  const claim = candidate.claim ?? "";
  const truncated = claim.length > maxClaimLen ? `${claim.slice(0, maxClaimLen)}…` : claim;
  return `  [${candidate.id ?? "?"}] ${truncated}`;
}

/**
 * Flag a probable truncated claim for the HUMAN reviewer (flair#1756 slice 2,
 * issue suggestion 3). Returns null when nothing is off; otherwise a short
 * descriptor. This is advisory ONLY — the refusal for structural imbalance
 * lives server-side in decideAutoPromote (the unattended path); a human
 * promote is a legitimate place to look at a fragment and decide.
 *
 * Reports STRUCTURAL imbalance (unbalanced backtick/paren/bracket/brace) and, as
 * a weaker signal, missing terminal punctuation. Neither claims the text is
 * incomplete — a balanced claim can still be a fragment.
 */
export function candidateIncompleteFlag(claim: unknown): string | null {
  // A malformed row can carry a non-string claim; normalize rather than throw,
  // so listing one bad candidate never takes down the whole review surface.
  const text = typeof claim === "string" ? claim : "";
  const imbalance = structuralImbalance(text);
  if (imbalance !== null) return `structurally incomplete (${imbalance}); the unattended auto-promote path refuses this`;
  if (!hasTerminalPunctuation(text)) return "no terminal punctuation — possible fragment";
  return null;
}

/**
 * Classifies a thrown /ReflectMemories execute-mode error for CLI display.
 * `api()` throws `Error(responseBodyText)` for non-2xx responses (see api()
 * above) — the two execute-mode failure bodies are:
 *   503 no-backend:        { error: "No generative backend configured..." }
 *   502 distillation_failed: { error: "distillation_failed", detail: "..." }
 * Any other shape (network errors, the 400/403 actor-resolution errors
 * prompt mode shares) falls back to "other" — printed as a plain message,
 * no docs pointer or retry hint attached since neither applies.
 */
export function describeReflectError(message: string): { kind: "no-backend" | "distillation-failed" | "other"; text: string } {
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") {
      if (parsed.error === "distillation_failed") {
        return { kind: "distillation-failed", text: String(parsed.detail ?? parsed.error) };
      }
      if (typeof parsed.error === "string" && parsed.error.startsWith("No generative backend configured")) {
        return { kind: "no-backend", text: parsed.error };
      }
      if (typeof parsed.error === "string") {
        return { kind: "other", text: parsed.error };
      }
    }
  } catch {
    // Not a JSON error body — network error, etc. Pass the raw message through.
  }
  return { kind: "other", text: message };
}

/** Print skips and errors; errors alone set exit 1. */
export function summarizeNightlyOutcome(row: { errors: string[]; skips: string[] }): {
  lines: string[];
  exitCode: 0 | 1;
} {
  const lines: string[] = [];
  if (row.errors.length > 0) {
    lines.push("Errors:");
    for (const e of row.errors) lines.push(`  - ${e}`);
  }
  if (row.skips.length > 0) {
    lines.push("Skips:");
    for (const s of row.skips) lines.push(`  - ${s}`);
  }
  return { lines, exitCode: row.errors.length > 0 ? 1 : 0 };
}

const REM_PAUSE_FLAG = resolve(resolveHome(), ".flair", "rem.paused");

function writeRemPauseSentinel(): void {
  const dir = dirname(REM_PAUSE_FLAG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(REM_PAUSE_FLAG, new Date().toISOString() + "\n", { mode: 0o600 });
}

export function register(program: Command): void {
  const DEFAULT_PORT = cli.DEFAULT_PORT;
  const __pkgVersion = cli.pkgVersion;
  // ─── flair rem ───────────────────────────────────────────────────────────────
  // Memory hygiene and reflection: light (NREM), rapid (REM), restorative (deep).

  const rem = program.command("rem").description("Memory hygiene and reflection");

  rem
    .command("light")
    .description("NREM — quick cleanup: delete expired, archive old, consolidate candidates")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--dry-run", "Preview changes without applying them")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const dryRun = !!opts.dryRun;

      console.log(`\n-- rem light${dryRun ? " (dry run)" : ""} --`);
      if (agentId) console.log(`Agent: ${agentId}`);

      try {
        // Step 1: Maintenance — expire + archive
        const maint = await api("POST", "/MemoryMaintenance", {
          ...(agentId ? { agentId } : {}),
          dryRun,
        });

        if (maint.error) {
          console.error(`Maintenance error: ${maint.error}`);
          process.exit(1);
        }

        const s = maint.stats ?? {};
        console.log("\nCleanup");
        console.log(`  Expired (deleted): ${s.expired ?? 0}`);
        console.log(`  Archived (soft):   ${s.archived ?? 0}`);
        console.log(`  Total scanned:     ${s.total ?? 0}`);
        if (s.errors) console.log(`  Errors:            ${s.errors}`);

        // Step 2: Consolidation candidates
        if (!agentId) {
          console.log("\nConsolidation skipped — no agent ID (pass --agent or set FLAIR_AGENT_ID)");
          return;
        }

        const consol = await api("POST", "/ConsolidateMemories", {
          agentId,
          scope: "all",
        });

        if (consol.error) {
          console.error(`Consolidation error: ${consol.error}`);
          process.exit(1);
        }

        const candidates = consol.candidates ?? [];
        const promote = candidates.filter((c: any) => c.suggestion === "promote");
        const archive = candidates.filter((c: any) => c.suggestion === "archive");

        console.log("\nConsolidation candidates");
        console.log(`  Promote: ${promote.length}`);
        console.log(`  Archive: ${archive.length}`);

        if (promote.length > 0) {
          console.log("\n  Promote:");
          for (const c of promote) {
            console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        }
        if (archive.length > 0) {
          console.log("\n  Archive:");
          for (const c of archive) {
            console.log(`    [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        }

        console.log(`\nDone.${dryRun ? " No changes applied (dry run)." : ""}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem rapid ──────────────────────────────────────────────────────────
  // Executes by default (§3C, issue #707): distills server-side via /ReflectMemories execute:true and
  // stages MemoryCandidate rows, printing a staged-candidate summary. --prompt-only
  // preserves the pre-#710 handoff behavior byte-for-byte, for the bring-your-
  // own-model workflow.

  rem
    .command("rapid")
    .description("REM — reflection/learning: distill recent memories into staged candidates")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--focus <type>", "lessons_learned | patterns | decisions | errors", "lessons_learned")
    .option("--since <date>", "ISO timestamp lower bound (default: 24h ago)")
    .option("--prompt-only", "Return the reflection prompt instead of executing (pre-#710 handoff behavior)")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent <id> or FLAIR_AGENT_ID env required");
        process.exit(1);
      }

      console.log(`\n-- rem rapid --`);
      console.log(`Agent: ${agentId}  Focus: ${opts.focus}`);

      const body: Record<string, any> = {
        agentId,
        focus: opts.focus,
      };
      if (opts.since) body.since = opts.since;

      if (opts.promptOnly) {
        // --prompt-only: EXACT pre-#710 behavior — prompt-return mode, unchanged.
        try {
          const result = await api("POST", "/ReflectMemories", body);

          if (result.error) {
            console.error(`Reflection error: ${result.error}`);
            process.exit(1);
          }

          console.log(`\nSource memories: ${result.count ?? 0}`);
          if (result.suggestedTags?.length) {
            console.log(`Tags: ${result.suggestedTags.join(", ")}`);
          }

          console.log("\n--- Reflection Prompt ---");
          console.log(result.prompt ?? "(no prompt returned)");
          console.log("--- End Prompt ---\n");
          console.log("Feed the prompt above to your LLM, then write insights back with:");
          console.log("  flair memory add --agent <id> --content <insight> --durability persistent --derived-from <source-ids>");
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // Default: execute mode — distill server-side, stage candidates.
      try {
        const result = await api("POST", "/ReflectMemories", { ...body, execute: true });
        const candidates: any[] = Array.isArray(result.candidates) ? result.candidates : [];

        console.log(`\nModel:      ${result.model ?? "?"}`);
        console.log(`Candidates: ${result.count ?? candidates.length}`);
        if (candidates.length > 0) {
          console.log();
          for (const c of candidates) console.log(formatCandidateLine(c));
        }
        console.log(`\nreview: flair rem candidates / flair rem promote <id>`);
      } catch (err: any) {
        const desc = describeReflectError(err.message ?? String(err));
        if (desc.kind === "no-backend") {
          console.error(`Reflection error: ${desc.text}`);
          console.error(`See docs/rem.md#configuration for how to point Flair at a models: backend.`);
        } else if (desc.kind === "distillation-failed") {
          console.error(`Reflection error: distillation failed — ${desc.text}`);
          console.error(`Retry, or run with --prompt-only for the manual handoff.`);
        } else {
          console.error(`Error: ${desc.text}`);
        }
        process.exit(1);
      }
    });

  rem
    .command("restorative")
    .description("Deep audit: full maintenance + consolidation (olderThan=7d) + reflection")
    .option("--port <port>", "Harper HTTP port")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--dry-run", "Preview maintenance changes without applying them")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const dryRun = !!opts.dryRun;

      console.log(`\n== rem restorative${dryRun ? " (dry run)" : ""} ==`);
      if (agentId) console.log(`Agent: ${agentId}`);

      try {
        // Step 1: Maintenance
        console.log("\n[1/3] Maintenance...");
        const maint = await api("POST", "/MemoryMaintenance", {
          ...(agentId ? { agentId } : {}),
          dryRun,
        });

        if (maint.error) {
          console.error(`Maintenance error: ${maint.error}`);
          process.exit(1);
        }

        const s = maint.stats ?? {};
        console.log(`  Expired: ${s.expired ?? 0}  Archived: ${s.archived ?? 0}  Scanned: ${s.total ?? 0}${s.errors ? `  Errors: ${s.errors}` : ""}`);

        // Step 2: Consolidation (skip if no agentId)
        if (agentId) {
          console.log("\n[2/3] Consolidation (scope=all, olderThan=7d)...");
          const consol = await api("POST", "/ConsolidateMemories", {
            agentId,
            scope: "all",
            olderThan: "7d",
          });

          if (consol.error) {
            console.error(`Consolidation error: ${consol.error}`);
            process.exit(1);
          }

          const candidates = consol.candidates ?? [];
          const promote = candidates.filter((c: any) => c.suggestion === "promote");
          const archive = candidates.filter((c: any) => c.suggestion === "archive");

          console.log(`  Promote candidates: ${promote.length}  Archive candidates: ${archive.length}`);
          for (const c of promote) {
            console.log(`    promote [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
          for (const c of archive) {
            console.log(`    archive [${c.memory?.id ?? "?"}] ${c.reason}`);
          }
        } else {
          console.log("\n[2/3] Consolidation skipped — no agent ID");
        }

        // Step 3: Reflection
        if (agentId) {
          console.log("\n[3/3] Reflection (scope=all)...");
          const reflect = await api("POST", "/ReflectMemories", {
            agentId,
            scope: "all",
          });

          if (reflect.error) {
            console.error(`Reflection error: ${reflect.error}`);
            process.exit(1);
          }

          console.log(`  Source memories: ${reflect.count ?? 0}`);
          if (reflect.suggestedTags?.length) {
            console.log(`  Tags: ${reflect.suggestedTags.join(", ")}`);
          }

          console.log("\n--- Reflection Prompt ---");
          console.log(reflect.prompt ?? "(no prompt returned)");
          console.log("--- End Prompt ---");
        } else {
          console.log("\n[3/3] Reflection skipped — no agent ID");
        }

        console.log(`\nRestorative cycle complete.${dryRun ? " No changes applied (dry run)." : ""}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem candidates ─────────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists staged distillations from the
  // MemoryCandidate table. Empty until the nightly cycle (later slice) starts
  // populating. Per spec § 5: candidates are NEVER auto-promoted; this command
  // is the operator's review surface.

  rem
    .command("candidates")
    .description("List staged memory candidates from the FLAIR-NIGHTLY-REM cycle (pending review)")
    .option("--port <port>", "Harper HTTP port")
    .option("--ops-port <port>", "Harper operations API port")
    .option("--admin-pass <pass>", "Admin password (or set FLAIR_ADMIN_PASS)")
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--agent <id>", "Agent ID (or FLAIR_AGENT_ID env)")
    .option("--status <s>", "Filter by status: pending | promoted | rejected (default: pending)")
    .option("--json", "Output as JSON for scripting")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      const status = opts.status ?? "pending";
      const validStatuses = new Set(["pending", "promoted", "rejected"]);
      if (!validStatuses.has(status)) {
        console.error(`Error: --status must be one of: pending, promoted, rejected (got: ${status})`);
        process.exit(1);
      }

      if (!agentId) {
        console.error(`${render.icons.error} --agent is required (or set FLAIR_AGENT_ID)`);
        process.exit(1);
      }

      const opsPort = resolveOpsPort(opts);
      const adminPass: string = opts.adminPass ?? process.env.FLAIR_ADMIN_PASS ?? "";
      if (!adminPass) {
        console.error(`${render.icons.error} --admin-pass or FLAIR_ADMIN_PASS required`);
        process.exit(1);
      }
      const auth = `Basic ${Buffer.from(`${resolveAdminUser(opts.adminUser)}:${adminPass}`).toString("base64")}`;

      try {
        const res = await fetch(`http://127.0.0.1:${opsPort}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({
            operation: "search_by_conditions",
            schema: "flair",
            table: "MemoryCandidate",
            operator: "and",
            conditions: [
              { search_attribute: "agentId", search_type: "equals", search_value: agentId },
              { search_attribute: "status", search_type: "equals", search_value: status },
            ],
            get_attributes: ["id", "claim", "generatedBy", "generatedAt", "status", "target", "reviewerId", "decidedAt", "supersedes"],
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`${render.icons.error} ${res.status} ${text}`);
          process.exit(1);
        }
        const candidates = await res.json() as any[];
        const mode = render.resolveOutputMode(opts);

        if (mode === "json") {
          const annotated = candidates.map((c: any) => ({ ...c, incompleteFlag: candidateIncompleteFlag(c.claim) }));
          console.log(render.asJSON({ agentId, status, count: candidates.length, candidates: annotated }));
          return;
        }

        const statusColor = status === "promoted" ? render.c.green : status === "rejected" ? render.c.red : render.c.yellow;
        console.log(
          `${render.wrap(render.c.bold, "REM candidates")}  ${render.wrap(render.c.dim, "—")} agent ${render.wrap(render.c.bold, agentId)} ${render.wrap(render.c.dim, "·")} ${render.wrap(statusColor, status)}`,
        );

        if (candidates.length === 0) {
          console.log(`\n${render.icons.info} ${render.wrap(render.c.dim, `No ${status} candidates.`)}`);
          if (status === "pending") {
            console.log(
              `${render.wrap(render.c.dim, "  Run")} flair rem nightly enable ${render.wrap(render.c.dim, "to start the nightly distillation cycle that populates this table.")}`,
            );
          }
          return;
        }

        candidates.sort((a, b) => String(b.generatedAt ?? "").localeCompare(String(a.generatedAt ?? "")));

        console.log();
        for (const c of candidates) {
          let tag: string;
          if (c.status === "promoted") {
            tag = `${render.wrap(render.c.green, "✓ promoted")} ${render.wrap(render.c.dim, "→")} ${render.wrap(render.c.bold, c.target ?? "?")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
          } else if (c.status === "rejected") {
            tag = `${render.wrap(render.c.red, "✗ rejected")} ${render.wrap(render.c.dim, `by ${c.reviewerId ?? "?"} ${render.relativeTime(c.decidedAt)}`)}`;
          } else {
            tag = `${render.wrap(render.c.yellow, "○ pending")} ${render.wrap(render.c.dim, `— ${c.generatedBy ?? "?"} ${render.relativeTime(c.generatedAt)}`)}`;
          }
          console.log(`  ${render.wrap(render.c.dim, c.id)}  ${tag}`);
          console.log(`    ${c.claim}`);
          const incompleteFlag = candidateIncompleteFlag(c.claim);
          if (incompleteFlag) {
            console.log(`    ${render.wrap(render.c.yellow, "⚠ possible incomplete claim")} ${render.wrap(render.c.dim, `— ${incompleteFlag}`)}`);
          }
          if (c.supersedes) {
            console.log(`    ${render.wrap(render.c.dim, `(supersedes ${c.supersedes} — recurring proposal)`)}`);
          }
          console.log("");
        }

        console.log(
          `${render.wrap(render.c.bold, String(candidates.length))} candidate${candidates.length > 1 ? "s" : ""}.`,
        );
        if (status === "pending") {
          console.log(`${render.wrap(render.c.dim, "Promote:")} flair rem promote <id> --rationale "<why>" --to (soul|memory)`);
          console.log(`${render.wrap(render.c.dim, "Reject: ")} flair rem reject <id> --reason "<why>"`);
        }
      } catch (err: any) {
        console.error(`${render.icons.error} ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem promote / reject helpers ──────────────────────────────────────
  // Pure validators extracted for testability. The action callbacks below thread
  // these through process.exit on failure; the helpers themselves are
  // side-effect-free.
  // ─── flair rem promote ───────────────────────────────────────────────────────
  // Slice 2 of FLAIR-NIGHTLY-REM (ops-2qq). Promote a candidate to either Soul
  // or persistent Memory. Both --rationale and --to are required (spec § 5: no
  // rubber-stamp). When --to=soul, --key is also required so the resulting
  // Soul row has a meaningful identifier.
  //
  // Trust-tier policy is enforced by the caller's authentication today (1.0):
  // admin pass → any promote; agent key → can write to own Memory/Soul. Server-
  // side trust-tier enforcement (endorsed agents → memory only, never soul) is
  // scoped for slice 2b when agent-routed promotion lands. For now, the
  // human-operator workflow is the supported path.

  rem
    .command("promote")
    .description("Promote a memory candidate to Soul or persistent Memory (rationale required)")
    .argument("<candidate-id>", "MemoryCandidate id to promote")
    .option("--port <port>", "Harper HTTP port")
    .option("--rationale <text>", "Why this candidate is being promoted (required, no rubber-stamp)")
    .option("--to <target>", "Promotion target: 'soul' or 'memory'")
    .option("--key <key>", "Soul key (required when --to=soul; e.g. 'lessons', 'preference-X')")
    .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
    .action(async (candidateId: string, opts: any) => {
      const validationErr = validatePromoteOpts(opts);
      if (validationErr) {
        console.error(`Error: ${validationErr}`);
        process.exit(1);
      }
      const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";
      // The human promote path must not record a reserved machine reviewerId
      // (Sherlock #4): that would launder automated attribution.
      const reviewerErr = validateHumanReviewerId(reviewerId);
      if (reviewerErr) {
        console.error(`Error: ${reviewerErr}`);
        process.exit(1);
      }

      try {
        if (opts.to === "memory") {
          const promoted = await api("POST", "/PromoteMemoryCandidate", {
            candidateId, rationale: opts.rationale,
            ...(opts.reviewer ? { reviewerId: opts.reviewer } : {}),
          });
          if (promoted?.error) throw new Error(promoted.error);
          console.log(`✅ Wrote Memory ${promoted.memoryId} (durability=persistent)`);
          console.log(`✅ Candidate ${candidateId} marked promoted → memory, reviewer=${promoted.reviewerId}`);
          return;
        }
        // Fetch the candidate
        const candidate = await api("GET", `/MemoryCandidate/${encodeRecordId(candidateId)}`);
        const candidateData = (candidate && !candidate.error) ? candidate : null;
        const decision = decideCandidateAction(candidateData, "promote");
        if (!decision.ok) {
          const msg: string = (decision as { ok: false; message: string }).message;
          console.error(`Error: candidate ${candidateId} ${msg}`);
          process.exit(1);
        }

        // ADK tag-lineage: derive the promoted-claim tag set.
        //
        // #1205b-1: if the engine stamped an authoritative `scopeTag` on the
        // candidate (scope:"tagged" distillation), consume it DIRECTLY and skip
        // the source re-read — correctness no longer depends on the source
        // memories still being readable (the #1205a seam closure). We only fall
        // back to re-reading sources when there is NO stamp (a pre-#1205b
        // candidate, or a non-tagged distillation).
        const stampedScopeTag: string | undefined =
          typeof candidate.scopeTag === "string" && candidate.scopeTag.length > 0 ? candidate.scopeTag : undefined;
        const sourceFetches: SourceMemoryFetch[] = [];
        if (!stampedScopeTag) {
          // No authoritative stamp — re-read sources to classify. Fail-closed for
          // ADK-sourced candidates whose per-user scope tag can't be confirmed;
          // unchanged for non-ADK candidates. See derivePromotedTags for rules.
          const sourceIds: string[] = Array.isArray(candidate.sourceMemoryIds) ? candidate.sourceMemoryIds : [];
          for (const sid of sourceIds) {
            try {
              const mem = await api("GET", `/Memory/${encodeRecordId(String(sid))}`);
              if (mem && !mem.error) {
                sourceFetches.push({ ok: true, tags: Array.isArray(mem.tags) ? mem.tags : [] });
              } else {
                sourceFetches.push({ ok: false });
              }
            } catch {
              sourceFetches.push({ ok: false });
            }
          }
        }
        const tagDecision = derivePromotedTags(candidateId, sourceFetches, stampedScopeTag);
        if (!tagDecision.ok) {
          console.error(`Error: candidate ${candidateId} — ${(tagDecision as { ok: false; reason: string }).reason}`);
          process.exit(1);
        }
        // Soul entries are agentId-scoped and cannot carry a per-user scope tag,
        // so an ADK-sourced candidate promoted to Soul is a cross-user leak by
        // construction — fail closed here and again on Soul.post/put so a
        // scripted PUT /Soul cannot bypass the CLI.
        if (opts.to === "soul" && (tagDecision as { adkSourced?: boolean }).adkSourced) {
          console.error(
            `Error: candidate ${candidateId} is ADK-sourced (scope tag ${tagDecision.tags[0]}); Soul is agentId-scoped and cannot carry a per-user scope tag — refusing to promote to Soul (would leak across users). Promote ADK-sourced candidates to memory.`,
          );
          process.exit(1);
        }
        const promotedTags = tagDecision.tags;

        const decidedAt = new Date().toISOString();

        // Memory promotion is handled by the server workflow above.
        const soulId = `${candidate.agentId}-${opts.key}`;
        const soulWrite = await api("PUT", `/Soul/${encodeRecordId(soulId)}`, {
          id: soulId,
          agentId: candidate.agentId,
          key: opts.key,
          value: candidate.claim,
          priority: "standard",
          durability: "persistent",
          createdAt: decidedAt,
          updatedAt: decidedAt,
        });
        if (soulWrite?.error) {
          console.error(`Error writing Soul: ${soulWrite.error}`);
          process.exit(1);
        }
        console.log(`✅ Wrote Soul ${soulId} (key=${opts.key})`);
        // Update the candidate row
        const upd = await api("PUT", `/MemoryCandidate/${encodeRecordId(candidateId)}`, {
          ...candidate,
          status: "promoted",
          target: opts.to,
          reviewerId,
          reviewRationale: opts.rationale,
          decidedAt,
        });
        if (upd?.error) {
          console.error(`Warning: candidate row update returned: ${upd.error}`);
        }
        console.log(`✅ Candidate ${candidateId} marked promoted → ${opts.to}, reviewer=${reviewerId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem reject ────────────────────────────────────────────────────────
  // Reject a candidate with a required --reason. Per spec § 5, rejected
  // candidates retain full decision history so recurring proposals are visible
  // via the supersedes chain.

  rem
    .command("reject")
    .description("Reject a memory candidate with a required reason")
    .argument("<candidate-id>", "MemoryCandidate id to reject")
    .option("--port <port>", "Harper HTTP port")
    .option("--reason <text>", "Why this candidate is being rejected (required)")
    .option("--reviewer <id>", "Reviewer agent id (default: FLAIR_AGENT_ID or 'admin')")
    .action(async (candidateId: string, opts: any) => {
      const validationErr = validateRejectOpts(opts);
      if (validationErr) {
        console.error(`Error: ${validationErr}`);
        process.exit(1);
      }
      const reviewerId = opts.reviewer || process.env.FLAIR_AGENT_ID || "admin";

      try {
        const candidate = await api("GET", `/MemoryCandidate/${encodeRecordId(candidateId)}`);
        const candidateData = (candidate && !candidate.error) ? candidate : null;
        const decision = decideCandidateAction(candidateData, "reject");
        if (!decision.ok) {
          const _d = decision as { ok: false; severity: "error" | "info"; message: string };
          if (_d.severity === "info") {
            console.log(`(candidate ${candidateId} ${_d.message})`);
            return;
          }
          console.error(`Error: candidate ${candidateId} ${_d.message}`);
          process.exit(1);
        }

        const decidedAt = new Date().toISOString();
        const upd = await api("PUT", `/MemoryCandidate/${encodeRecordId(candidateId)}`, {
          ...candidate,
          status: "rejected",
          reviewerId,
          reviewRationale: opts.reason,
          decidedAt,
        });
        if (upd?.error) {
          console.error(`Error: candidate row update failed: ${upd.error}`);
          process.exit(1);
        }
        console.log(`✅ Candidate ${candidateId} rejected by ${reviewerId}`);
        console.log(`   Reason: ${opts.reason}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem nightly run-once ──────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM § 3. Manually invokes the nightly cycle code
  // path — same module the scheduler will call in PR-2. Useful for:
  //   - First-time operators verifying the cycle works before turning on the
  //     scheduled timer.
  //   - The dry-run-first-run guard (spec § 10) when the scheduler isn't yet
  //     installed.
  //   - Debugging a stale snapshot or audit row.
  //
  // `nightly enable` / `disable` / `status` land in PR-2 (scheduler templates).

  const remNightly = rem.command("nightly").description("Scheduled REM nightly cycle (manual trigger + scheduler management)");

  // `enable` / `disable` / `status` — scheduler install/uninstall (slice-1 PR-2).
  // macOS: writes ~/Library/LaunchAgents/dev.flair.rem.nightly.plist and bootstraps it.
  // Linux: writes ~/.config/systemd/user/flair-rem-nightly.{timer,service} and enables the timer.
  // Snapshot data and the audit log are preserved through enable/disable cycles.

  remNightly
    .command("enable")
    .description("Install the nightly scheduler (launchd on macOS, systemd timer on Linux)")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--at <HH:MM>", "Local time to run nightly (default 03:00)", "03:00")
    .option("--flair-url <url>", "Flair HTTP URL the runner will hit (default http://127.0.0.1:<port>)")
    .option(ADMIN_PASS_FILE_FLAG, "Absolute path of the owner-only admin-password file the shim passes to run-once (default: ~/.flair/admin-pass)")
    .action(async (opts: any) => {
      if (opts.adminPassFile === "") {
        console.error("Error: --admin-pass-file must not be empty");
        process.exit(1);
      }
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      const match = /^(\d{1,2}):(\d{2})$/.exec(opts.at);
      if (!match) {
        console.error(`Error: --at must be HH:MM (got: ${opts.at})`);
        process.exit(1);
      }
      const hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);

      const port = readPortFromConfig() ?? DEFAULT_PORT;
      const flairUrl = opts.flairUrl || process.env.FLAIR_URL || `http://127.0.0.1:${port}`;

      const { enableScheduler, formatEnableReport } = await import("../rem/scheduler.js");
      try {
        const r = enableScheduler({ agentId, flairUrl, hour, minute, adminPassFile: opts.adminPassFile });
        // formatEnableReport() owns the success-vs-failure decision (flair#850:
        // do not print a success headline before activation is known to have
        // succeeded) — see src/rem/scheduler.ts for the unit-tested logic.
        const { lines, ok } = formatEnableReport(r, { hour, minute, agentId, flairUrl });
        for (const line of lines) console.log(line);
        if (!ok) process.exit(1);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("disable")
    .description("Remove the nightly scheduler (keeps snapshots + audit log)")
    .option("--remove-shim", "Also delete the ~/.flair/bin/flair-rem-nightly shim")
    .action(async (opts: any) => {
      const { disableScheduler } = await import("../rem/scheduler.js");
      try {
        const r = disableScheduler({ removeShim: !!opts.removeShim });
        if (r.removed.length === 0) {
          console.log(`(REM nightly scheduler was not installed on ${r.platform})`);
          return;
        }
        console.log(`✅ REM nightly scheduler disabled (${r.platform})`);
        console.log(`   Removed:`);
        for (const p of r.removed) console.log(`     ${p}`);
        if (r.unloadResult && r.unloadResult.code !== 0) {
          console.log(`   Unload:      ${r.unloadCommand.join(" ")} → code ${r.unloadResult.code}`);
          if (r.unloadResult.stderr) console.log(`     stderr: ${r.unloadResult.stderr.trim()}`);
        }
        console.log(`\nSnapshots at ~/.flair/snapshots/ and the audit log at`);
        console.log(`~/.flair/logs/rem-nightly.jsonl are preserved.`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("status")
    .description("Show whether the nightly scheduler is installed and genuinely active")
    .action(async () => {
      const { schedulerStatus, formatStatusReport } = await import("../rem/scheduler.js");
      try {
        const s = schedulerStatus();
        const { lines } = formatStatusReport(s);
        for (const line of lines) console.log(line);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  remNightly
    .command("run-once")
    .description("Run one nightly cycle now (snapshot + log). Same code path the scheduler will use.")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--ops-port <port>", "Harper operations API port")
    .option(ADMIN_PASS_FLAG, ADMIN_PASS_HELP)
    .option(ADMIN_PASS_FILE_FLAG, ADMIN_PASS_FILE_HELP)
    .option("--admin-user <name>", "Admin username for Basic auth (env: FLAIR_ADMIN_USER; default: admin)")
    .option("--dry-run", "Log the row but skip the snapshot write")
    .action(async (opts: any) => {
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      const { runNightlyCycle, formatPendingCandidates, formatAutoPromoted } = await import("../rem/runner.js");
      // The runner is agent-authed and cannot reach the ops port itself. When
      // admin credentials are available, inject ops-API and admin-authed REST
      // helpers so the pending-candidate count and the admin-gated dedup step
      // can run. A file named with --admin-pass-file is read through the ONE
      // shared resolver before any cycle work; when it is unavailable the run
      // fails at startup with NOT RUN rather than issuing an agent-authed call
      // that an agent key cannot authorize.
      let adminPass = "";
      try {
        adminPass = resolveAdminPassFromSources({
          adminPassFile: opts.adminPassFile,
          adminPass: opts.adminPass,
          envPass: process.env.FLAIR_ADMIN_PASS ?? process.env.HDB_ADMIN_PASSWORD,
        });
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        if (opts.adminPassFile !== undefined) {
          const remedy = err instanceof AdminPassSourceError
            ? ""
            : ` Provide an owner-only (chmod 600), non-empty admin password file${opts.adminPassFile === "" ? " via --admin-pass-file <path>" : ` at ${opts.adminPassFile}`}, then re-run \`flair rem nightly run-once\`.`;
          console.error(`Dedup:      NOT RUN — ${err.message}${remedy}`);
        }
        process.exit(1);
      }
      // Every agent-scoped call is signed by the selected agent and nothing
      // else: the identity is pinned here (never FLAIR_AGENT_ID), and
      // signedOnly refuses FLAIR_TOKEN / FLAIR_ADMIN_PASS / the local
      // admin-pass file. A selected agent with no key is refused, not
      // silently replaced by an ambient credential.
      const agentApiCall = (method: string, path: string, body?: unknown) =>
        api(method, path, body, { agentId, agentIdSource: "flag", signedOnly: true });
      const adminApiCall = adminPass
        ? (method: string, path: string, body?: unknown) =>
            api(method, path, body, { explicitAdminPass: adminPass, adminUser: opts.adminUser, agentId: null })
        : undefined;
      const opsSearch = adminPass
        ? buildOpsSearch({ opsPort: resolveOpsPort(opts), adminUser: opts.adminUser, adminPass })
        : undefined;
      try {
        const healthBase = (process.env.FLAIR_URL || `http://127.0.0.1:${resolveHttpPort({})}`).replace(/\/+$/, "");
        const result = await runNightlyCycle({
          agentId,
          flairVersion: __pkgVersion,
          apiCall: agentApiCall,
          adminApiCall,
          opsSearch,
          dryRun: !!opts.dryRun,
          healthProbe: async (timeoutMs) => {
            const t = Date.now();
            try {
              const res = await fetch(`${healthBase}/Health`, { signal: AbortSignal.timeout(timeoutMs) });
              if (!res.ok) {
                return { ok: false, elapsedMs: Date.now() - t, error: `GET /Health returned HTTP ${res.status}` };
              }
              return { ok: true, elapsedMs: Date.now() - t };
            } catch (err: any) {
              return { ok: false, elapsedMs: Date.now() - t, error: err?.message ?? String(err) };
            }
          },
        });
        const row = result.logRow;
        console.log(`-- rem nightly run-once${opts.dryRun ? " (dry-run)" : ""} --`);
        console.log(`Agent:      ${agentId}`);
        console.log(`Status:     ${result.status}`);
        if (result.snapshotPath) {
          console.log(`Snapshot:   ${result.snapshotPath}`);
        }
        console.log(`Memories:   ${row.memoryCount ?? "—"}`);
        console.log(`Souls:      ${row.soulCount ?? "—"}`);
        console.log(`Pending:    ${formatPendingCandidates(row.pendingCandidates)}`);
        if (typeof row.archived === "number" || typeof row.expired === "number") {
          // #1503: `archived` counts validTo-expired and old-session rows the
          // pass soft-archived; `expired` counts ephemeral rows past their
          // expiresAt. Label each so "Expired: N, Archived: 0" cannot read as
          // the same row counted on two axes.
          console.log(`Archived:   ${row.archived ?? "—"} (validTo-expired + old sessions)`);
          console.log(`Expired:    ${row.expired ?? "—"} (ephemeral rows past expiresAt)`);
        }
        // row.candidates populates when step 5 (distillation) was attempted
        // this cycle — see src/rem/runner.ts. Absent when dry-run skipped it.
        if (row.candidates) {
          console.log(`Staged:     ${row.candidates.length} candidate${row.candidates.length === 1 ? "" : "s"}`);
        }
        if (row.distill) {
          const remaining = Math.max(0, row.distill.unreflected - row.distill.gathered);
          console.log(`Distilled:  ${row.distill.gathered} memor${row.distill.gathered === 1 ? "y" : "ies"} (cap ${row.distill.maxMemories}; ${remaining} unreflected remaining)`);
          if (row.distill.aborted) console.log(`Aborted:    yes — in-flight distillation stopped (flair rem pause)`);
        }
        // row.autoPromoted populates when step 5b (#1205b-2 auto-promote) ran
        // this cycle and the server returned a response without an error — i.e.
        // a non-aborted, non-dry-run
        // cycle with active ADK tags or selected settled continuity sessions
        // (flair#1257 slice 3); successful distillation is not required.
        // Incomplete and unconfirmed promotions are named on the line
        // (flair#2714).
        if (row.autoPromoted) {
          console.log(formatAutoPromoted(row.autoPromoted));
        }
        // A guard refusal carries null counts and the guard's named state.
        const dedupRow = row.dedup;
        if (dedupRow) {
          if ("embeddingSpace" in dedupRow) {
            console.log(`Dedup:      not computed — embedding space ${dedupRow.embeddingSpace.state} (no new counts were written)`);
          } else {
            console.log(`Dedup:      ${dedupRow.clusterCount} cluster${dedupRow.clusterCount === 1 ? "" : "s"} (${dedupRow.totalMemoriesInClusters} memories, largest ${dedupRow.largestClusterSize})`);
          }
        }
        console.log(`Duration:   ${row.durationMs}ms`);
        if (result.status === "refused") {
          console.log(`\nNote: REM refused to start because /Health could not be served.`);
          console.log(`Restore /Health before retrying, or \`flair rem pause\` to stop the scheduler.`);
        }
        if (row.errors.length > 0 || row.skips.length > 0) {
          const outcome = summarizeNightlyOutcome(row);
          for (const line of outcome.lines) console.log(line);
          if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
        }
        if (result.status === "paused") {
          console.log(`\nNote: REM is paused (sentinel ~/.flair/rem.paused or FLAIR_REM_PAUSE env).`);
          console.log(`Resume with: flair rem resume`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ─── flair rem snapshot list ─────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM (ops-2qq). Lists snapshot tarballs under
  // ~/.flair/snapshots/<agent>/. Snapshot creation lives inside the nightly
  // runner (and exposed via `flair rem nightly run-once`) — there is no
  // user-facing `rem snapshot create` because that would invite operators to
  // create snapshots out of sync with the audit log. The list is the surface.

  const remSnapshot = rem.command("snapshot").description("REM nightly snapshots (tar.gz archives of agent memory + soul)");

  remSnapshot
    .command("list")
    .description("List REM snapshots for an agent (or all agents)")
    .option("--agent <id>", "Filter to a single agent")
    .option("--json", "Output as JSON")
    .action(async (opts: any) => {
      const { listSnapshots } = await import("../rem/snapshot.js");
      const rows = listSnapshots(opts.agent);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("(no REM snapshots — ~/.flair/snapshots/ is empty or absent)");
        console.log("\nSnapshots are produced by the nightly cycle. Run `flair rem nightly run-once`");
        console.log("to generate one manually (slice 1).");
        return;
      }
      const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
      const fileW = Math.max(20, ...rows.map((r) => r.file.length));
      console.log(`  ${"agent".padEnd(agentW)}  ${"file".padEnd(fileW)}  size      age`);
      for (const r of rows) {
        console.log(`  ${r.agent.padEnd(agentW)}  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
      }
      console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
    });

  // ─── flair rem restore <date> ────────────────────────────────────────────────
  // Slice 1 + 2 of FLAIR-NIGHTLY-REM § 9.
  //
  // Default (no --apply): filesystem-only extract for inspection. Writes
  //   memories.jsonl / soul.json / metadata.json to a target directory.
  //   Harper state is unchanged.
  //
  // --apply: live replay. Reads the snapshot contents, takes a pre-restore
  //   snapshot of the agent's CURRENT state (so this restore is itself
  //   reversible), then DELETEs current memories/souls for the agent and PUTs
  //   the snapshot's rows back. Per-row failures are captured per-row; the
  //   pre-restore snapshot's path is reported so operator can roll back if
  //   something goes wrong mid-flight.
  //
  // The <date> argument is an ISO-timestamp prefix or date-only prefix; the
  // command picks the latest snapshot matching that prefix.

  addSharedCredentialOptions(rem.command("restore <date>"))
    .description("Restore from a REM snapshot (inspect by default; --apply rewinds Harper state)")
    .option("--agent <id>", "Agent id (or FLAIR_AGENT_ID env)")
    .option("--target <dir>", "Directory to extract into (default: <snapshot>.restored, only used without --apply)")
    .option("--dry-run", "Plan-only — list contents or planned counts without writing")
    .option("--apply", "Live replay: rewind Harper state to the snapshot (irreversible without the pre-restore snapshot)")
    .action(async (date: string, opts: any) => {
      const { listSnapshots, extractSnapshot } = await import("../rem/snapshot.js");
      const agentId = opts.agent || process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("Error: --agent or FLAIR_AGENT_ID env required");
        process.exit(1);
      }
      let rows;
      try {
        rows = listSnapshots(agentId);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      const matches = rows.filter((r) => r.file.startsWith(date));
      if (matches.length === 0) {
        console.error(`Error: no snapshot found for agent '${agentId}' matching date '${date}'`);
        if (rows.length > 0) {
          console.error(`  Available: ${rows.slice(0, 5).map((r) => r.file.replace(/\.tar\.gz$/, "")).join(", ")}`);
        } else {
          console.error(`  No snapshots exist for ${agentId}. Run \`flair rem nightly run-once\` to create one.`);
        }
        process.exit(1);
      }
      // listSnapshots returns descending by mtime, so matches[0] is the newest
      // snapshot for the date prefix.
      const match = matches[0];

      // --apply path: live replay via src/rem/restore.ts
      if (opts.apply) {
        const { applySnapshot } = await import("../rem/restore.js");
        applyAdminPassFile(opts);
        let restoreTarget: RestoreTarget;
        try {
          restoreTarget = resolveRestoreTarget({
            flairUrl: process.env.FLAIR_URL,
            opsPort: process.env.FLAIR_OPS_PORT,
            opsTarget: process.env.FLAIR_OPS_TARGET,
          });
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        // Candidates are only reachable through the ops port (Harper has no
        // REST search_by_conditions route), so the dry-run candidate count
        // needs admin creds too. Dry-run treats credential resolution as
        // best-effort — a plan-only command must not fail on a bad credential
        // file — while --apply requires creds (Soul rewrite) and fails loudly.
        let adminPass: string | undefined;
        try {
          adminPass = resolveLocalAdminPass(opts.adminPass, !isLocalBase(restoreTarget.baseUrl));
        } catch (err: any) {
          if (!opts.dryRun) throw err;
          adminPass = undefined;
        }
        if (!opts.dryRun && !adminPass) {
          console.error(
            "Error: --admin-pass, --admin-pass-file, or FLAIR_ADMIN_PASS required for rem restore --apply " +
              "(Soul rewrite is operator-only; an agent key is refused).",
          );
          process.exit(1);
        }
        // The candidate listing goes to the operations API and every write to
        // the target's HTTP endpoint. establishRestorePair is the preflight
        // check of that pair (see its comment for what it establishes on a
        // loopback URL and on any other URL), and it runs before applySnapshot
        // sends anything. Without an admin credential (a dry run only) there is
        // no listing and no check, and only the target is read. Every REST
        // call below refuses redirects, so it stays at the checked endpoint.
        if (adminPass) {
          try {
            await establishRestorePair(restoreTarget, { user: resolveAdminUser(opts.adminUser), pass: adminPass });
          } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        }
        // With a resolved admin credential (a live replay always has one; an
        // --apply --dry-run may not), every Memory, Soul and MemoryCandidate
        // read, delete and write sends it explicitly:
        // --admin-pass, --admin-pass-file, or the default resolveLocalAdminPass
        // fell back to. A dry run without one reads through the shared
        // resolver's own tiers.
        const targetApi = (method: string, path: string, body?: unknown) =>
          api(method, path, body, adminPass
            ? { baseUrl: restoreTarget.baseUrl, explicitAdminPass: adminPass, adminUser: opts.adminUser, agentId: null, refuseRedirects: true }
            : { baseUrl: restoreTarget.baseUrl, refuseRedirects: true });
        const opsSearch = adminPass
          ? buildOpsSearch({ opsUrl: restoreTarget.opsUrl, adminUser: opts.adminUser, adminPass })
          : undefined;
        const soulApiCall = adminPass ? targetApi : undefined;
        try {
          const result = await applySnapshot({
            agentId,
            snapshotPath: match.path,
            flairVersion: __pkgVersion,
            apiCall: targetApi,
            opsSearch,
            soulApiCall,
            dryRun: !!opts.dryRun,
          });
          const verb = opts.dryRun ? "(dry-run) would" : "";
          console.log(`${opts.dryRun ? "(dry-run) " : ""}flair rem restore --apply${opts.dryRun ? "" : ""}`);
          console.log(`  Status:       ${result.status}`);
          console.log(`  Snapshot:     ${match.path}`);
          if (result.preRestoreSnapshotPath) {
            console.log(`  Pre-restore:  ${result.preRestoreSnapshotPath}`);
            console.log(`                (rollback: flair rem restore <pre-restore-date> --agent ${agentId} --apply)`);
          }
          console.log(`  Deleted:      ${result.deleted.memories} memories, ${result.deleted.souls} souls, ${result.deleted.candidates} candidates`);
          console.log(`  Restored:     ${result.restored.memories} memories, ${result.restored.souls} souls`);
          if (result.errors.length > 0) {
            console.log(`  Errors:`);
            for (const e of result.errors) console.log(`    - ${e}`);
          }
          if (result.status === "failed") process.exit(1);
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        return;
      }

      // Default: filesystem extract.
      try {
        const result = await extractSnapshot({
          snapshotPath: match.path,
          targetDir: opts.target,
          dryRun: !!opts.dryRun,
        });
        if (opts.dryRun) {
          console.log(`(dry-run) snapshot: ${match.path}`);
          for (const e of result.entries) {
            console.log(`  ${e.path}  (${humanBytes(e.size)})`);
          }
          return;
        }
        console.log(`✅ Extracted: ${match.path}`);
        console.log(`   To:        ${result.targetDir}`);
        for (const e of result.entries) {
          console.log(`     ${e.path}  (${humanBytes(e.size)})`);
        }
        console.log(`\nNote: this is a filesystem extract — Harper state is unchanged.`);
        console.log(`To actually rewind state, re-run with --apply.`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
  // ─── flair rem pause / resume ────────────────────────────────────────────────
  // Slice 1 of FLAIR-NIGHTLY-REM § 9. The pause sentinel is checked by the
  // nightly runner before any side effects. Env-var FLAIR_REM_PAUSE=1 is also
  // honored — lets ops pause fleet-wide without writing a file.
  // #1515: the same sentinel aborts an in-flight /ReflectMemories gather on
  // the Harper host (checked between yield points) so an operator can stop a
  // runaway run without restarting Harper.
  rem
    .command("pause")
    .description("Pause nightly REM runs and abort an in-flight distillation gather")
    .action(() => {
      writeRemPauseSentinel();
      console.log(`✅ REM nightly runs paused (sentinel: ${REM_PAUSE_FLAG})`);
      console.log(`   In-flight distillation will abort at the next yield.`);
      console.log(`   Resume with: flair rem resume`);
    });

  rem
    .command("abort")
    .description("Abort an in-flight REM distillation (same sentinel as pause)")
    .action(() => {
      writeRemPauseSentinel();
      console.log(`✅ REM abort requested (sentinel: ${REM_PAUSE_FLAG})`);
      console.log(`   In-flight distillation will stop at the next yield; the scheduler stays paused.`);
      console.log(`   Resume with: flair rem resume`);
    });

  rem
    .command("resume")
    .description("Resume nightly REM runs — removes the pause sentinel")
    .action(() => {
      if (existsSync(REM_PAUSE_FLAG)) {
        rmSync(REM_PAUSE_FLAG);
        console.log(`✅ REM nightly runs resumed (removed ${REM_PAUSE_FLAG})`);
      } else {
        console.log(`(REM was not paused — no sentinel at ${REM_PAUSE_FLAG})`);
      }
      if (process.env.FLAIR_REM_PAUSE === "1") {
        console.log(`\n⚠ FLAIR_REM_PAUSE=1 env var is also set; unset it to fully resume.`);
      }
    });
}
