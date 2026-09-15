#!/usr/bin/env node
/**
 * local-npm-registry.mjs — test-only npm registry shim for the macOS
 * launchd adopt-then-upgrade CI lane (flair#1671).
 *
 * WHY THIS EXISTS. `flair upgrade` installs its target with
 * `npm install -g @tpsdev-ai/flair@<latest>`. The lane has to exercise the
 * PR's checkout, but the PR build is not (and must not be) published. This
 * shim serves the PR's `npm pack` tarball as the requested version of
 * `@tpsdev-ai/flair`, and proxies every other `@tpsdev-ai/*` request to the
 * public registry so the package's own dependencies still resolve.
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
 *     --package-json /abs/path/package.json
 *
 * Prints `READY <port>` on stdout once listening, so the caller can wait for
 * it deterministically instead of sleeping.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";

const UPSTREAM = "https://registry.npmjs.org";

function parseArgs(argv) {
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

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);
const pkgName = String(args.package ?? "");
const version = String(args.version ?? "");
const tarball = String(args.tarball ?? "");
const packageJsonPath = args["package-json"] ? String(args["package-json"]) : "";

if (!Number.isInteger(port) || port <= 0) {
  console.error("local-npm-registry: --port must be a positive integer");
  process.exit(2);
}
if (!pkgName || !version || !tarball) {
  console.error("local-npm-registry: --package, --version and --tarball are required");
  process.exit(2);
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

const minimalPackument = {
  name: pkgName,
  "dist-tags": { latest: version },
  versions: { [version]: versionDocument },
  time: { [version]: new Date().toISOString() },
};

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
async function loadPackument() {
  try {
    const res = await fetch(`${UPSTREAM}/${pkgName}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`upstream packument returned HTTP ${res.status}`);
    const upstream = await res.json();
    return {
      ...upstream,
      "dist-tags": { ...(upstream["dist-tags"] ?? {}), latest: version },
      versions: { ...(upstream.versions ?? {}), [version]: versionDocument },
    };
  } catch (err) {
    console.error(
      `local-npm-registry: could not load ${pkgName} packument from ${UPSTREAM} ` +
        `(${err.message}); serving only ${version} — rollbacks to other versions ` +
        `will not resolve through this shim`,
    );
    return minimalPackument;
  }
}

const packument = await loadPackument();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function proxyToUpstream(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const headers = { ...req.headers, host: target.host };
  const upstream = httpsRequest(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`local-npm-registry upstream error: ${err.message}`);
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const isMetadata =
    pathname === `/${pkgName}` ||
    pathname === `/${pkgName}/` ||
    pathname === `/${pkgName}/latest`;
  const isTarball =
    pathname === `/${pkgName}/-/${tarballName}` || pathname.endsWith(`/${tarballName}`);

  if (req.method === "GET" || req.method === "HEAD") {
    if (isMetadata) {
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

  // Everything else in the @tpsdev-ai scope (the bundled descriptors package,
  // for example) is proxied to the public registry so dependency resolution
  // is not narrowed by this shim.
  proxyToUpstream(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY ${port}`);
  console.error(
    `local-npm-registry: serving ${pkgName}@${version} from ${tarball} ` +
      `(sha512 ${integrity.slice(0, 24)}…); proxying other ${pkgName.split("/")[0]}/* to ${UPSTREAM}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
