#!/usr/bin/env node
/**
 * local-npm-registry.mjs — test-only npm registry shim for the macOS
 * launchd adopt-then-upgrade CI lane (flair#1671).
 *
 * WHY THIS EXISTS. `flair upgrade` installs its target with
 * `npm install -g @tpsdev-ai/flair@<latest>`. The lane has to exercise the
 * PR's checkout, but the PR build is not (and must not be) published. This
 * shim serves the PR's `npm pack` tarball as the requested version of
 * `@tpsdev-ai/flair`, and proxies allow-listed `@tpsdev-ai/*` requests to the
 * public registry so the package's own dependencies still resolve.
 *
 * SSRF SHAPE GUARD (flair#1684). The proxy builds an outbound URL, so it must
 * not accept an arbitrary request path. Only `@tpsdev-ai/<name>` where <name>
 * is in the explicit lockstep allow-list below is forwarded, and only for:
 *   - a packument:            /@tpsdev-ai/<name>
 *   - a version manifest:     /@tpsdev-ai/<name>/<version>
 *                             where <version> is `latest` or `X.Y.Z`
 *   - a tarball:              /@tpsdev-ai/<name>/-/<name>-<version>.tgz
 * Everything else is refused with 404 and a log line, so a crafted path cannot
 * steer the request at another host or path.
 *
 * The lane configures ONLY the scoped registry
 * (`npm config set @tpsdev-ai:registry http://127.0.0.1:<port>`), so the
 * package's non-scoped dependencies (harper, commander, …) go straight to
 * the public registry and never traverse this process.
 *
 * NOT FOR PRODUCTION. No auth, no signing, no persistence. It exists to make
 * one CI lane exercise an unpublished tarball.
 *
 * Usage:
 *   node scripts/ci/local-npm-registry.mjs \
 *     --port 4873 \
 *     --package @tpsdev-ai/flair \
 *     --version 0.54.1 \
 *     --tarball /abs/path/tpsdev-ai-flair-0.54.1.tgz \
 *     --package-json /abs/path/package.json \
 *     [--upstream https://registry.npmjs.org]
 *
 * Prints `READY <port>` on stdout once listening, so the caller can wait for
 * it deterministically instead of sleeping.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://registry.npmjs.org";
const SCOPE = "@tpsdev-ai";

// The lockstep packages this shim may forward. This is an EXPLICIT allow-list,
// not "anything under the scope": the proxy builds an outbound URL, so the set
// of reachable upstream paths has to be closed. Kept in sync with the
// version-bearing workspace packages (scripts/check-version-sync.mjs
// PACKAGE_JSONS). `cursor-flair` and `cursor-wake-runner` are deliberately
// absent — they are not lockstep releases.
export const LOCKSTEP_PACKAGE_NAMES = new Set([
  "flair",
  "adk-flair",
  "flair-bench",
  "flair-client",
  "flair-mcp",
  "flair-tool-descriptors",
  "langgraph-flair",
  "n8n-nodes-flair",
  "openclaw-flair",
  "pi-flair",
]);

const VERSION_SEGMENT = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TARBALL_FILE = /^([a-z0-9-]+)-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$/;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

/**
 * Map a decoded request pathname to the upstream path it is allowed to fetch,
 * or `null` if the shape is not on the allow-list. The returned string is built
 * from the scope constant plus `encodeURIComponent` of each validated dynamic
 * segment, so an untrusted path can never control the outbound host or escape
 * the allow-listed package.
 */
export function resolveUpstreamPath(pathname) {
  const parts = pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0] !== SCOPE) return null;

  const name = parts[1];
  if (!LOCKSTEP_PACKAGE_NAMES.has(name)) return null;
  const safeName = encodeURIComponent(name);

  // /@tpsdev-ai/<name>
  if (parts.length === 2) {
    return `/${SCOPE}/${safeName}`;
  }

  // /@tpsdev-ai/<name>/<version>  (version manifest / dist-tag)
  if (parts.length === 3) {
    const version = parts[2];
    if (version !== "latest" && !VERSION_SEGMENT.test(version)) return null;
    return `/${SCOPE}/${safeName}/${encodeURIComponent(version)}`;
  }

  // /@tpsdev-ai/<name>/-/<name>-<version>.tgz
  if (parts.length === 4 && parts[2] === "-") {
    const match = TARBALL_FILE.exec(parts[3]);
    if (!match || match[1] !== name) return null;
    return `/${SCOPE}/${safeName}/-/${encodeURIComponent(match[0])}`;
  }

  return null;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function refuse(res, method, pathname) {
  console.error(`local-npm-registry: refusing ${method} ${pathname} (not an allow-listed lockstep registry path)`);
  sendJson(res, 404, { error: "not found" });
}

function proxyToUpstream(upstream, upstreamPath, req, res) {
  const target = new URL(upstreamPath, upstream);
  const headers = { ...req.headers, host: target.host };
  const upstreamReq = httpsRequest(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`local-npm-registry upstream error: ${err.message}`);
  });
  req.pipe(upstreamReq);
}

/**
 * The packument npm gets for the overridden package.
 *
 * It MUST include the public registry's other versions, not just the
 * overridden one: `flair upgrade` can roll back to the previously installed
 * version by running `npm install -g @tpsdev-ai/flair@<old>` through this
 * same scoped registry. A packument carrying only the PR version would turn
 * that rollback into an unrelated registry error and confound the lane. So we
 * merge the PR version into the upstream packument and leave every other
 * version resolving to the public registry untouched.
 */
async function loadPackument(upstream, pkgName, version, versionDocument) {
  const minimalPackument = {
    name: pkgName,
    "dist-tags": { latest: version },
    versions: { [version]: versionDocument },
    time: { [version]: new Date().toISOString() },
  };
  try {
    const res = await fetch(`${upstream}/${pkgName}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`upstream packument returned HTTP ${res.status}`);
    const upstreamDoc = await res.json();
    return {
      ...upstreamDoc,
      "dist-tags": { ...(upstreamDoc["dist-tags"] ?? {}), latest: version },
      versions: { ...(upstreamDoc.versions ?? {}), [version]: versionDocument },
    };
  } catch (err) {
    console.error(
      `local-npm-registry: could not load ${pkgName} packument from ${upstream} ` +
        `(${err.message}); serving only ${version} — rollbacks to other versions ` +
        `will not resolve through this shim`,
    );
    return minimalPackument;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = Number(args.port);
  const pkgName = String(args.package ?? "");
  const version = String(args.version ?? "");
  const tarball = String(args.tarball ?? "");
  const packageJsonPath = args["package-json"] ? String(args["package-json"]) : "";
  const upstream = args.upstream ? String(args.upstream) : UPSTREAM;

  if (!Number.isInteger(port) || port <= 0) {
    console.error("local-npm-registry: --port must be a positive integer");
    return 2;
  }
  if (!pkgName || !version || !tarball) {
    console.error("local-npm-registry: --package, --version and --tarball are required");
    return 2;
  }
  try {
    // Validate the upstream override eagerly so a typo fails at start-up, not
    // on the first proxied dependency.
    new URL(upstream);
  } catch {
    console.error(`local-npm-registry: --upstream is not a valid URL: ${upstream}`);
    return 2;
  }

  const tarballBytes = readFileSync(tarball);
  const tarballStat = statSync(tarball);
  const sha1 = createHash("sha1").update(tarballBytes).digest("hex");
  const sha512 = createHash("sha512").update(tarballBytes).digest("base64");
  const integrity = `sha512-${sha512}`;
  const tarballName = basename(tarball);
  const tarballURL = `http://127.0.0.1:${port}/${pkgName}/-/${tarballName}`;

  const pkgJson = packageJsonPath
    ? JSON.parse(readFileSync(packageJsonPath, "utf-8"))
    : {};

  // A registry version document is the package manifest plus the `dist` block
  // npm resolves the tarball from. Spread the manifest first so `name`,
  // `version`, `dependencies`, `bin`, `scripts`, `engines` and `bundleDependencies`
  // are exactly what the tarball declares — never hand-maintained here.
  const versionDocument = {
    ...pkgJson,
    name: pkgName,
    version,
    _id: `${pkgName}@${version}`,
    dist: {
      tarball: tarballURL,
      shasum: sha1,
      integrity,
      fileCount: undefined,
      unpackedSize: undefined,
    },
  };

  const packument = await loadPackument(upstream, pkgName, version, versionDocument);

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("local-npm-registry: malformed request path");
      return;
    }

    // `/latest` is the VERSION MANIFEST on the real registry (a single version
    // document with a top-level `version`), not the full packument. `flair
    // upgrade` reads `data.version` from it, so serving the packument here would
    // make the update check skip the package entirely.
    const isLatest = pathname === `/${pkgName}/latest`;
    const isPackument =
      pathname === `/${pkgName}` ||
      pathname === `/${pkgName}/`;
    const isTarball =
      pathname === `/${pkgName}/-/${tarballName}` || pathname.endsWith(`/${tarballName}`);

    if (req.method === "GET" || req.method === "HEAD") {
      if (isLatest) {
        sendJson(res, 200, versionDocument);
        return;
      }
      if (isPackument) {
        sendJson(res, 200, packument);
        return;
      }
      if (isTarball) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": tarballStat.size,
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(tarball).pipe(res);
        return;
      }
    }

    // Everything else must be on the allow-list of lockstep package paths
    // before it reaches the outbound request. A path that is not is refused,
    // never forwarded.
    const upstreamPath = resolveUpstreamPath(pathname);
    if (upstreamPath === null) {
      refuse(res, req.method ?? "GET", pathname);
      return;
    }
    proxyToUpstream(upstream, upstreamPath, req, res);
  });

  server.listen(port, "127.0.0.1", () => {
    const bound = server.address();
    const boundPort = typeof bound === "object" && bound ? bound.port : port;
    console.log(`READY ${boundPort}`);
    console.error(
      `local-npm-registry: serving ${pkgName}@${version} from ${tarball} ` +
        `(sha512 ${integrity.slice(0, 24)}…); proxying allow-listed ${SCOPE}/* to ${upstream}`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }

  return 0;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().then(
    (code) => {
      // A successful start keeps the process alive on the listening server;
      // only a non-zero outcome (bad args) should terminate it here.
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(`local-npm-registry: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
