/**
 * http-bind.ts — the ONE constructor for a Harper HTTP bind value.
 *
 * Every place Flair hands Harper an HTTP listener address — `HTTP_PORT` in a
 * spawn env or a launchd plist, and `http.port` inside a `HARPER_SET_CONFIG`
 * payload — goes through `httpBind()`. It returns a SHAPE (`{ bindValue, host,
 * port }`), not a string, because two different consumers need two different
 * halves of the same answer:
 *
 *   - the LISTENER wants the host-qualified `host:port` form (Harper's
 *     `listenOnPorts` splits a config port value on its LAST colon and binds
 *     that host; a bare number binds all interfaces), and
 *   - every CORS allow-list entry and every loopback URL builder wants the
 *     PORT half on its own.
 *
 * Returning only the qualified string would force every caller to re-split it —
 * i.e. to re-implement the parser this module exists to be the single copy of.
 *
 * ## Why the constructor is not an exposure classifier
 *
 * There is already a predicate for "is this bind exposed?", `LOOPBACK_HOSTS` in
 * `ops-api-bind.ts` (`{127.0.0.1, localhost, ::1}`). This module does NOT reuse
 * it, and must not: that set answers a DIFFERENT question. It classifies
 * whether a bind is narrowed; it does not guarantee that a client on IPv4
 * loopback can reach the listener. The two disagree on exactly the hosts that
 * matter here:
 *
 *   - `::1` (IPv6 loopback) passes "is it exposed?" (it is not — it is
 *     loopback) but a client dialing `127.0.0.1` does NOT reach it. Harper
 *     passes the parsed host straight to `listen` with no loopback translation
 *     (`dist/server/threads/threadServer.js`, `listenOnPorts`), so `[::1]:PORT`
 *     would satisfy every exposure check, fail every self-call, and leave every
 *     bind assertion green.
 *   - `localhost` depends on name resolution and may resolve to `::1` on a
 *     v6-first host.
 *
 * So this constructor allows a host only when it GUARANTEES IPv4-loopback
 * reachability: `127.0.0.1`, or a wildcard (which includes IPv4 loopback).
 * Every other host — a specific non-loopback interface address, an IPv6-only
 * loopback, a hostname, anything unparseable — is refused. That refusal is
 * load-bearing: all of Flair's credentialed self-calls hardcode
 * `http://127.0.0.1:<port>`, so a bind that excludes IPv4 loopback leaves them
 * pointing at a dead port while every bind check still passes.
 *
 * Deliberate widening is still possible through the escape hatch
 * (`--http-bind` / `FLAIR_HTTP_BIND` / persisted `httpBind`), but only to a
 * WILDCARD — the hatch waives the exposure restriction, never the connectivity
 * requirement.
 */

import { harperPortValue } from "./harper-port-value.js";

/** The only non-wildcard host Flair will bind: it is IPv4 loopback by definition. */
export const DEFAULT_HTTP_BIND_HOST = "127.0.0.1";

/**
 * Wildcard hosts. Binding one of these includes IPv4 loopback, so the
 * hardcoded `http://127.0.0.1:<port>` self-calls still land — this is why a
 * wildcard is the only widening the constructor will produce.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);


/** A resolved Harper HTTP bind: the qualified string plus its two halves. */
export interface HarperHttpBind {
  /** Host-qualified `host:port` — what a listener config value must be. */
  bindValue: string;
  /** The bind host (brackets stripped), validated for IPv4-loopback reachability. */
  host: string;
  /** The numeric port. */
  port: number;
}

/**
 * Thrown when a requested bind host cannot be guaranteed reachable on IPv4
 * loopback. Callers refuse BEFORE writing anything (plist, config, spawn env),
 * so a bad host can never be persisted.
 */
export class UnreachableHttpBindHostError extends Error {
  constructor(public readonly host: string) {
    super(
      `refusing to bind Harper's HTTP listener to "${host}": every credentialed ` +
        `self-call Flair makes hardcodes 127.0.0.1, so a bind that does not include ` +
        `IPv4 loopback would leave them pointing at a dead port. Use 127.0.0.1 ` +
        `(the default), or a wildcard (0.0.0.0 / ::) for deliberate widening.`,
    );
    this.name = "UnreachableHttpBindHostError";
  }
}

/** Strip a single pair of surrounding square brackets from an IPv6 literal. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * True when a bind host guarantees an IPv4-loopback client can reach the
 * listener. `127.0.0.1` and a wildcard yes; everything else no. Exported so
 * the escape-hatch validation and the tests name the same predicate.
 */
export function guaranteesIpv4Loopback(host: string): boolean {
  const h = stripBrackets(host.trim());
  return h === DEFAULT_HTTP_BIND_HOST || WILDCARD_HOSTS.has(h);
}

function isIpv6Literal(host: string): boolean {
  return host.includes(":");
}

/**
 * Build the Harper HTTP bind value, refusing any host that does not guarantee
 * IPv4-loopback reachability. An absent/empty host defaults to `127.0.0.1`.
 *
 * `port` must be an integer in 1..65535 (`resolveHttpPort` guarantees this for
 * the production callers; the check is here so a stray value cannot reach a
 * config payload that `new URL()` or Harper's `listen` would later reject).
 */
export function httpBind(host: string | null | undefined, port: number | string): HarperHttpBind {
  const rawHost = host === undefined || host === null ? "" : String(host).trim();
  const resolvedHost = rawHost === "" ? DEFAULT_HTTP_BIND_HOST : rawHost;

  const portNum = typeof port === "number" ? port : Number(String(port).trim());
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new RangeError(`refusing to build an HTTP bind for port "${String(port)}": must be an integer in 1..65535`);
  }

  if (!guaranteesIpv4Loopback(resolvedHost)) {
    throw new UnreachableHttpBindHostError(resolvedHost);
  }

  const h = stripBrackets(resolvedHost);
  const bindValue = isIpv6Literal(h) ? `[${h}]:${portNum}` : `${h}:${portNum}`;
  return { bindValue, host: h, port: portNum };
}

/**
 * The CORS allow-list entries for an HTTP bind. Uses the PORT half only:
 * CORS is about the browser-facing origin, and every entry Flair writes is a
 * loopback origin regardless of which interface the listener bound.
 */
export function httpCorsAccessList(port: number | string): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

// ─── repair: preserving an instance's recorded coordinates ─────────────────
//
// `doctor --fix` is the ONE bind emitter that does not go through `httpBind()`:
// it promises not to move the instance's coordinates, so it PRESERVES what the
// instance recorded (a bare legacy port stays bare; an already-qualified
// `host:port` keeps its host). The helpers below are shared between the CLI's
// plist writer and the pure repair PLANNER, so the planner can refuse an
// unsupported configuration BEFORE the executor stops anything.

/**
 * Preserve an instance's recorded HTTP port value VERBATIM for a repair.
 *
 * Throws for a DISABLED value (absent, null or empty) and for an UNSUPPORTED
 * value (a port that cannot be parsed). Callers refuse rather than substituting
 * a default: a default here is a coordinate change that can enable a listener
 * the instance never had.
 */
export function preserveHttpPortValue(raw: unknown): string {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(
      "refusing to repair the launchd plist: the instance's harper-config.yaml records no http.port, " +
        "so the HTTP listener is disabled. Repair preserves the instance's coordinates and will not " +
        "substitute a default port, which would enable a listener the instance did not have.",
    );
  }
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= 1 && raw <= 65535) return String(raw);
    throw new Error(`refusing to repair the launchd plist: http.port is ${raw}, which is not a usable port`);
  }
  const str = String(raw).trim();
  if (harperPortValue(str) === null) {
    throw new Error(
      `refusing to repair the launchd plist: http.port is "${str}", which is not a parseable bind value`,
    );
  }
  return str;
}

/**
 * A secure-listener port, reduced to its number. Returns undefined for a
 * disabled value (so the key is omitted and a disabled listener STAYS
 * disabled), and throws for an unparseable one (so a caller refuses rather than
 * writing a value it cannot read).
 */
export function preserveSecurePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
  const port = harperPortValue(raw);
  if (port === null) {
    throw new Error(`refusing to repair the launchd plist: secure port "${String(raw)}" is not a usable port`);
  }
  return port;
}

/**
 * The host half of a preserved `host:port` bind value, or null when the value
 * is bare (no host) or unparseable. Mirrors `ops-api-bind.ts`'s `parseBindHost`
 * so both readers agree on what "the host half" is.
 */
export function bindHostOf(value: string): string | null {
  const s = value.trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    return close === -1 ? null : s.slice(1, close);
  }
  const lastColon = s.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const tail = s.slice(lastColon + 1);
  return /^\d+$/.test(tail) ? s.slice(0, lastColon) : null;
}

/**
 * The host to qualify an ENABLED secure listener with, given the (preserved)
 * plaintext bind host. A bare secure value binds ALL interfaces exactly like a
 * bare plaintext port does — Harper feeds `http.securePort` through the same
 * `listenOnPorts` path — so leaving it bare would narrow the plaintext listener
 * and leave TLS wide, the asymmetry this work exists to close. A plaintext host
 * that cannot guarantee IPv4 loopback (e.g. a legacy `::1`) is not mirrored;
 * the secure listener falls back to the loopback default instead of producing a
 * bind Flair's self-calls cannot reach.
 */
export function secureBindHostFor(plaintextHost: string | null): string {
  return plaintextHost !== null && guaranteesIpv4Loopback(plaintextHost) ? plaintextHost : DEFAULT_HTTP_BIND_HOST;
}
