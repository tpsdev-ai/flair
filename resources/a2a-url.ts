// URL resolution for the A2A adapter — flair#507.
//
// A default local Flair install listens on DEFAULT_HTTP_PORT (19926, the
// CLI's `DEFAULT_PORT` in src/cli.ts), NOT on 9926 (the legacy early-install
// port). The A2A agent-card `url` and the streaming catch-up self-fetch must
// reflect the REAL listening port, or a remote A2A peer that follows discovery
// hits a dead port.
//
// Kept free of any @harperfast/harper import so the resolution logic is
// unit-testable without spinning up Harper (mirrors agentcard-fields.ts —
// avoids the simulator-pattern drift that let the AdminInstance predicate be
// reproduced-not-imported).

// The CLI's DEFAULT_HTTP_PORT (src/cli.ts `DEFAULT_PORT`). Keep in sync.
export const DEFAULT_HTTP_PORT = 19926;

export type RequestLike = { headers?: any } | undefined;

// Loopback base URL for in-process self-calls (e.g. the streaming catch-up
// fetch). Points at the port Flair is ACTUALLY listening on, which Harper
// exposes via HTTP_PORT in the runtime env — never the public/proxy URL.
// Falls back to DEFAULT_HTTP_PORT for a default local install.
export function localBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${env.HTTP_PORT || DEFAULT_HTTP_PORT}`;
}

// Public base URL advertised in the A2A agent card so remote peers can reach
// this Flair. Mirrors AdminInstance.resolvePublicUrl (flair#404):
//   1. FLAIR_PUBLIC_URL (explicit override, always wins)
//   2. Request headers (X-Forwarded-Proto/Host or Host) — how the caller
//      actually reached us
//   3. http://127.0.0.1:${HTTP_PORT} — local-only fallback on the REAL port
export function resolvePublicBaseUrl(
  request?: RequestLike,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.FLAIR_PUBLIC_URL) {
    return env.FLAIR_PUBLIC_URL.replace(/\/$/, "");
  }

  const getHeader = (name: string): string | undefined => {
    const h = request?.headers;
    if (!h) return undefined;
    if (typeof h.get === "function") return h.get(name) ?? h.get(name.toLowerCase()) ?? undefined;
    if (typeof h === "object") {
      const obj = h.asObject ?? h;
      return obj[name] ?? obj[name.toLowerCase()] ?? undefined;
    }
    return undefined;
  };

  const fwdProto = getHeader("X-Forwarded-Proto");
  const fwdHost = getHeader("X-Forwarded-Host");
  const host = fwdHost ?? getHeader("Host");

  if (host && /^[\w.\-:]+$/.test(host)) {
    const scheme = fwdProto && (fwdProto === "http" || fwdProto === "https") ? fwdProto : "https";
    const effectiveScheme = fwdProto ? scheme : (host.includes(":") ? "http" : scheme);
    return `${effectiveScheme}://${host}`;
  }

  return localBaseUrl(env);
}
