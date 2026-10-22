import { describe, it, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

/**
 * The dependency audit gate run against the real audit tools (flair#2278).
 *
 * audit-gate.test.ts drives the gate with stand-in `bun` and `npm` scripts.
 * The cases here run the bun that runs this file (the first case checks that
 * it is the version the `audit` CI job pins) and the npm on PATH. In a gate
 * case each tool talks to its own local registry fixture: an HTTP server on
 * 127.0.0.1 with an ephemeral port. A case copies the real gate script into a
 * fixture repo, points bun (bunfig.toml) and npm (a temporary userconfig) at
 * their fixture servers, runs the gate under the pinned bun, and checks the
 * gate's exit status and output. The servers record every request, and each
 * gate case checks which fixture each tool reached.
 *
 * The fixture allowlist has no entries, so a gate run that gets past both
 * audit stages passes exactly when both stages report zero advisories.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GATE_SCRIPT = join(REPO_ROOT, "scripts", "audit-gate.mjs");
const ALLOWLIST_POLICY = JSON.parse(
  readFileSync(join(REPO_ROOT, ".github", "audit-allowlist.json"), "utf8"),
).policy;
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
/** The bun version the `audit` job installs with setup-bun. */
const PINNED_BUN = /\n  audit:\n[\s\S]*?bun-version: "([^"]+)"/.exec(TEST_YML)?.[1];

/** Ports production Flair listens on; a fixture server must never hold one. */
const RESERVED_PORTS = new Set([9925, 9926, 19925, 19926]);
/** A fixture server drops a connection idle this long. */
const SERVER_SOCKET_TIMEOUT_MS = 10_000;
/** A fixture server closes itself after this long, even if a case never closes it. */
const SERVER_LIFETIME_MS = 60_000;
/** Deadline for one gate run (both audit stages). The process group is killed at it. */
const GATE_TIMEOUT_MS = 30_000;
/** Deadline for one direct `bun audit` run. */
const TOOL_TIMEOUT_MS = 15_000;
/** Per-case budget: a deadline above plus fixture setup and teardown. */
const CASE_BUDGET_MS = 45_000;

const DEP = "audit-fixture-dep";
const GHSA = "GHSA-0000-0000-0001";
const BULK_REQUEST = "POST /-/npm/v1/security/advisories/bulk";
const PASS_MARKER = "PASS —";
/**
 * The six consumer-install inputs: the flag, the allowlist source, the package
 * the flag's prefix must hold, and the workspace directory the job packs it
 * from. Every gate case gives each flag its own prefix.
 */
const CONSUMER_INPUTS = [
  { flag: "--npm-install-prefix", source: "npm-install", pkg: "@tpsdev-ai/flair", dir: "." },
  { flag: "--adk-npm-install-prefix", source: "npm-install-adk", pkg: "@tpsdev-ai/adk-flair", dir: "packages/adk-flair-js" },
  { flag: "--mcp-npm-install-prefix", source: "npm-install-mcp", pkg: "@tpsdev-ai/flair-mcp", dir: "packages/flair-mcp" },
  { flag: "--openclaw-npm-install-prefix", source: "npm-install-openclaw", pkg: "@tpsdev-ai/openclaw-flair", dir: "packages/openclaw-flair" },
  { flag: "--pi-npm-install-prefix", source: "npm-install-pi", pkg: "@tpsdev-ai/pi-flair", dir: "packages/pi-flair" },
  { flag: "--n8n-npm-install-prefix", source: "npm-install-n8n", pkg: "@tpsdev-ai/n8n-nodes-flair", dir: "packages/n8n-nodes-flair" },
];
/** The version of every fixture workspace manifest, and so of every packed fixture package. */
const FIXTURE_VERSION = "1.0.0";
/** The file name stem `npm pack` gives a package: `@scope/name` becomes `scope-name`. */
const tarballStem = (pkg: string) => pkg.replace(/^@/, "").replace("/", "-");
/** The gate's arguments: each input's flag followed by the prefix `prefixOf` gives it. */
const prefixArgs = (prefixOf: (input: (typeof CONSUMER_INPUTS)[number]) => string) =>
  CONSUMER_INPUTS.flatMap((input) => [input.flag, prefixOf(input)]);

/** The advisory the "advisory" registry answer lists for DEP. */
const ADVISORY_ANSWER = {
  [DEP]: [
    {
      id: 1,
      url: `https://github.com/advisories/${GHSA}`,
      title: "Fixture advisory",
      severity: "high",
      vulnerable_versions: "<1.0.1",
      cwe: [],
      cvss: { score: 0, vectorString: null },
    },
  ],
};

/** npm reads the package document of each package an advisory names. */
const PACKUMENT = {
  name: DEP,
  "dist-tags": { latest: "1.0.1" },
  versions: {
    "1.0.0": { name: DEP, version: "1.0.0", dist: { tarball: "http://127.0.0.1/unused-1.0.0.tgz" } },
    "1.0.1": { name: DEP, version: "1.0.1", dist: { tarball: "http://127.0.0.1/unused-1.0.1.tgz" } },
  },
};

/** What a fixture registry answers to an audit request. */
type Answer =
  | "clean" // 200, `{}`
  | "advisory" // 200, one advisory for DEP
  | "uuid"
  | "http-500" // 500
  | "malformed" // 200, a body that is not JSON
  | "not-an-advisory-map"; // 200, a JSON object that lists no advisories

interface Registry {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function respond(answer: Answer, url: string, res: ServerResponse): void {
  // Both the bulk endpoint and the older quick endpoint npm 10 falls back to.
  if (url.startsWith("/-/npm/v1/security/")) {
    switch (answer) {
      case "clean":
        return send(res, 200, "{}");
      case "advisory":
        return send(res, 200, JSON.stringify(ADVISORY_ANSWER));
      case "uuid":
        return send(res, 200, JSON.stringify({ uuid: [{
          ...ADVISORY_ANSWER[DEP][0], url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq",
          severity: "moderate", vulnerable_versions: "<11.1.1",
        }] }));
      case "http-500":
        return send(res, 500, "registry fixture: internal error", "text/plain");
      case "malformed":
        return send(res, 200, "{not json");
      case "not-an-advisory-map":
        return send(res, 200, JSON.stringify({ message: "audit failed" }));
    }
  }
  if (url === `/${DEP}`) return send(res, 200, JSON.stringify(PACKUMENT));
  if (url === "/uuid") return send(res, 200, JSON.stringify({
    name: "uuid", "dist-tags": { latest: "11.1.1" },
    versions: {
      "9.0.1": { name: "uuid", version: "9.0.1" },
      "9.0.2": { name: "uuid", version: "9.0.2" },
      "11.1.1": { name: "uuid", version: "11.1.1" },
    },
  }));
  send(res, 404, "{}");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** A fixture registry on 127.0.0.1 with an ephemeral port. */
async function startRegistry(answer: Answer): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => respond(answer, req.url ?? "", res));
  });
  server.setTimeout(SERVER_SOCKET_TIMEOUT_MS, (socket) => socket.destroy());
  await listen(server);
  let closed = false;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      clearTimeout(lifetime);
      server.closeAllConnections();
      server.close(() => resolve());
    });
  lifetime = setTimeout(() => void close(), SERVER_LIFETIME_MS);
  lifetime.unref();
  const { port } = server.address() as AddressInfo;
  if (RESERVED_PORTS.has(port)) {
    await close();
    throw new Error(`fixture registry was given reserved port ${port}; re-run the test`);
  }
  return { url: `http://127.0.0.1:${port}/`, requests, close };
}

/** A loopback registry URL with nothing listening: a fixture port, closed before use. */
async function refusedRegistry(): Promise<Registry> {
  const registry = await startRegistry("clean");
  await registry.close();
  return registry;
}

const BUN_LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "@tpsdev-ai/flair",
      "dependencies": {
        "${DEP}": "1.0.0",
      },
    },
  },
  "packages": {
    "${DEP}": ["${DEP}@1.0.0", "", {}, "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="],
  }
}
`;

interface Fixture {
  root: string;
  /** Each input's own prefix, by source. */
  prefixes: Record<string, string>;
  env: Record<string, string>;
}

interface FixtureOptions {
  bunRegistry: string;
  npmRegistry: string;
  bunLockfile?: boolean;
  npmLockfile?: boolean;
}

/**
 * A fixture repo holding a copy of the gate, an allowlist with no entries, a
 * bun project with one dependency (its manifest is also the root input's
 * workspace manifest), the workspace manifest of each other input, and one
 * npm prefix per input. Each prefix holds the fixture dependency and its
 * input's install record, the rows an npm install of the packed tarball
 * writes (the real-npm identity cases below check that shape against real
 * npm). The tools' environment is not inherited: it holds only PATH (the
 * pinned bun's directory first), HOME, TMPDIR, the npm config file locations,
 * both tool caches and the gate's date. `npmLockfile: false` removes the root
 * input's prefix's package-lock.json.
 */
function makeFixture(opts: FixtureOptions): Fixture {
  const root = tempDir("flair-audit-real-tools-");
  for (const dir of ["scripts", ".github", "home", "tmp", "cache"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(GATE_SCRIPT, join(root, "scripts", "audit-gate.mjs"));
  writeFileSync(
    join(root, ".github", "audit-allowlist.json"),
    JSON.stringify({ policy: ALLOWLIST_POLICY, entries: [] }),
  );

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version: FIXTURE_VERSION, private: true, dependencies: { [DEP]: "1.0.0" } }),
  );
  if (opts.bunLockfile !== false) writeFileSync(join(root, "bun.lock"), BUN_LOCK);
  writeFileSync(join(root, "bunfig.toml"), `[install]\nregistry = "${opts.bunRegistry}"\n`);

  const prefixes: Record<string, string> = {};
  for (const input of CONSUMER_INPUTS) {
    if (input.dir !== ".") {
      mkdirSync(join(root, input.dir), { recursive: true });
      writeFileSync(join(root, input.dir, "package.json"), JSON.stringify({ name: input.pkg, version: FIXTURE_VERSION }));
    }
    const prefix = join(root, `prefix-${input.source}`);
    prefixes[input.source] = prefix;
    const tgz = `file:../packed/${tarballStem(input.pkg)}-${FIXTURE_VERSION}.tgz`;
    const manifest = { name: "consumer", version: "1.0.0", dependencies: { [DEP]: "1.0.0", [input.pkg]: tgz } };
    for (const [pkg, version] of [[DEP, "1.0.0"], [input.pkg, FIXTURE_VERSION]] as const) {
      mkdirSync(join(prefix, "node_modules", pkg), { recursive: true });
      writeFileSync(join(prefix, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg, version }));
    }
    writeFileSync(join(prefix, "package.json"), JSON.stringify(manifest));
    if (opts.npmLockfile !== false || input.source !== "npm-install") {
      writeFileSync(
        join(prefix, "package-lock.json"),
        JSON.stringify({
          ...manifest,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": manifest,
            [`node_modules/${DEP}`]: { version: "1.0.0" },
            [`node_modules/${input.pkg}`]: { version: FIXTURE_VERSION, resolved: tgz },
          },
        }),
      );
    }
  }
  writeFileSync(
    join(root, "npmrc"),
    `registry=${opts.npmRegistry}\nfetch-retries=0\nfetch-timeout=10000\nupdate-notifier=false\nfund=false\n`,
  );
  writeFileSync(join(root, "npmrc-global"), "");

  return {
    root,
    prefixes,
    env: {
      // The pinned bun first, so the gate's `bun audit` runs the same binary.
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_globalconfig: join(root, "npmrc-global"),
      npm_config_cache: join(root, "cache", "npm"),
      BUN_INSTALL_CACHE_DIR: join(root, "cache", "bun"),
      AUDIT_GATE_TODAY: "2026-10-01",
    },
  };
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a process with a deadline. It leads its own process group, so the
 * deadline also stops any audit tool it started.
 */
function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

interface GateCase {
  run: Run;
  bunRequests: string[];
  npmRequests: string[];
}

type RegistryChoice = Answer | "refused";

async function registryFor(choice: RegistryChoice): Promise<Registry> {
  return choice === "refused" ? refusedRegistry() : startRegistry(choice);
}

/** Run the gate with the bun stage on one fixture registry and the npm stage on another. */
async function gateCase(
  bunChoice: RegistryChoice,
  npmChoice: RegistryChoice,
  lockfiles: { bunLockfile?: boolean; npmLockfile?: boolean } = {},
): Promise<GateCase> {
  const bunRegistry = await registryFor(bunChoice);
  const npmRegistry = await registryFor(npmChoice);
  try {
    const f = makeFixture({ bunRegistry: bunRegistry.url, npmRegistry: npmRegistry.url, ...lockfiles });
    const run = await runProcess(
      process.execPath,
      [join(f.root, "scripts", "audit-gate.mjs"), ...prefixArgs((input) => f.prefixes[input.source]!)],
      f.root,
      f.env,
      GATE_TIMEOUT_MS,
    );
    return { run, bunRequests: [...bunRegistry.requests], npmRequests: [...npmRegistry.requests] };
  } finally {
    await Promise.all([bunRegistry.close(), npmRegistry.close()]);
  }
}

function expectFailedClosed(run: Run, stage: string): void {
  expect(run.timedOut).toBe(false);
  expect(run.status).toBe(1);
  expect(run.stdout).not.toContain(PASS_MARKER);
  expect(run.stderr).toContain("DEPENDENCY AUDIT GATE: FAILED TO RUN");
  expect(run.stderr).toContain(stage);
}

const BUN_STAGE = "`bun audit`";
const NPM_STAGE = "`npm audit --omit=dev --json` in ";

interface FailureCase {
  name: string;
  choice: RegistryChoice;
  /** False when the case removes the stage's lockfile. */
  lockfile: boolean;
  /** True when the tool reaches its fixture registry in this case. */
  reachesRegistry: boolean;
}

const FAILURES: FailureCase[] = [
  { name: "an HTTP 500 from the registry", choice: "http-500", lockfile: true, reachesRegistry: true },
  { name: "a refused connection", choice: "refused", lockfile: true, reachesRegistry: false },
  { name: "a registry answer that is not JSON", choice: "malformed", lockfile: true, reachesRegistry: true },
  {
    name: "a registry answer that lists no advisories but is not empty",
    choice: "not-an-advisory-map",
    lockfile: true,
    reachesRegistry: true,
  },
  { name: "a missing lockfile", choice: "clean", lockfile: false, reachesRegistry: false },
];

describe("audit gate with the real bun and npm against a local registry (flair#2278)", () => {
  it("runs the bun version the audit job pins", () => {
    expect(PINNED_BUN).toBeDefined();
    expect(Bun.version).toBe(PINNED_BUN as string);
  });

  it(
    "passes when both stages report zero advisories",
    async () => {
      const { run, bunRequests, npmRequests } = await gateCase("clean", "clean");
      expect(run.timedOut).toBe(false);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("advisories reported: 0 (none)");
      expect(run.stdout).toContain(PASS_MARKER);
      expect(bunRequests).toContain(BULK_REQUEST);
      expect(npmRequests).toContain(BULK_REQUEST);
    },
    CASE_BUDGET_MS,
  );

  it(
    "blocks the advisory each stage reports",
    async () => {
      const { run, bunRequests, npmRequests } = await gateCase("advisory", "advisory");
      expect(run.timedOut).toBe(false);
      expect(run.status).toBe(1);
      expect(run.stderr).not.toContain("FAILED TO RUN");
      // bun's report and the npm report of each of the six fixture prefixes
      // (each holds the fixture dependency) see the same advisory, so the gate
      // counts seven (flair#2398 added the ADK input, flair#2757 four more).
      expect(run.stdout).toContain("advisories reported: 7 (7 high)");
      expect(run.stdout).toContain(`HIGH ${GHSA} in ${DEP} (<1.0.1) is NOT allowlisted`);
      expect(run.stdout).not.toContain(PASS_MARKER);
      expect(bunRequests).toContain(BULK_REQUEST);
      expect(npmRequests).toContain(BULK_REQUEST);
    },
    CASE_BUDGET_MS,
  );

  for (const failure of FAILURES) {
    it(
      `fails closed on ${failure.name} in the bun stage`,
      async () => {
        const { run, bunRequests, npmRequests } = await gateCase(failure.choice, "clean", {
          bunLockfile: failure.lockfile,
        });
        expectFailedClosed(run, BUN_STAGE);
        expect(bunRequests.includes(BULK_REQUEST)).toBe(failure.reachesRegistry);
        // The bun stage runs first; its refusal ends the gate before npm runs.
        expect(npmRequests).toEqual([]);
      },
      CASE_BUDGET_MS,
    );

    // Without the root input's package-lock.json the gate refuses that prefix
    // at the identity check, before either stage runs (the case after this loop).
    if (!failure.lockfile) continue;
    it(
      `fails closed on ${failure.name} in the npm stage`,
      async () => {
        const { run, bunRequests, npmRequests } = await gateCase("clean", failure.choice, {
          npmLockfile: failure.lockfile,
        });
        expectFailedClosed(run, NPM_STAGE);
        expect(bunRequests).toContain(BULK_REQUEST);
        expect(npmRequests.includes(BULK_REQUEST)).toBe(failure.reachesRegistry);
      },
      CASE_BUDGET_MS,
    );
  }
});

describe("a prefix without package-lock.json", () => {
  it(
    "is refused at the identity check, before either audit stage runs",
    async () => {
      const { run, bunRequests, npmRequests } = await gateCase("clean", "clean", { npmLockfile: false });
      expect(run.timedOut).toBe(false);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--npm-install-prefix ");
      expect(run.stderr).toContain(`is not an npm install of the packed @tpsdev-ai/flair@${FIXTURE_VERSION}`);
      expect(run.stderr).toContain("no readable package-lock.json");
      expect(run.stdout).toBe("");
      expect(bunRequests).toEqual([]);
      expect(npmRequests).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});

describe("ADK uuid paths from real npm audit", () => {
  for (const { outside, version, title } of [
    { outside: false, version: "9.0.1", title: "allows the named uuid chain at the allowlist version" },
    { outside: true, version: "9.0.1", title: "blocks the additional uuid path" },
    { outside: false, version: "9.0.2", title: "blocks a different installed uuid version" },
  ]) {
    it(title, async () => {
      const bunRegistry = await startRegistry("clean");
      const npmRegistry = await startRegistry("uuid");
      try {
        const f = makeFixture({ bunRegistry: bunRegistry.url, npmRegistry: npmRegistry.url });
        const adkPrefix = join(f.root, "adk-prefix");
        const chain = ["@tpsdev-ai/adk-flair", "@google/adk", "@google-cloud/vertexai", "google-auth-library", "gaxios", "uuid"];
        const manifest = { name: "adk-consumer", version: "1.0.0", dependencies: {
          "@tpsdev-ai/adk-flair": "1.0.0", ...(outside ? { uuid: "9.0.1" } : {}),
        } };
        const packages: Record<string, object> = { "": manifest };
        let node = "";
        for (const [i, pkg] of chain.entries()) {
          node += `${node ? "/" : ""}node_modules/${pkg}`;
          const row = { name: pkg, version: pkg === "uuid" ? version : "1.0.0",
            dependencies: i + 1 < chain.length ? { [chain[i + 1]!]: "*" } : {},
          };
          // The ADK package's row is its install record from the packed tarball.
          packages[node] = i === 0 ? { ...row, resolved: `file:../packed/${tarballStem(pkg)}-${FIXTURE_VERSION}.tgz` } : row;
          mkdirSync(join(adkPrefix, node), { recursive: true });
          writeFileSync(join(adkPrefix, node, "package.json"), JSON.stringify(row));
        }
        if (outside) {
          packages["node_modules/uuid"] = { name: "uuid", version: "9.0.1" };
          mkdirSync(join(adkPrefix, "node_modules/uuid"), { recursive: true });
          writeFileSync(join(adkPrefix, "node_modules/uuid/package.json"), JSON.stringify(packages["node_modules/uuid"]));
        }
        writeFileSync(join(adkPrefix, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(adkPrefix, "package-lock.json"), JSON.stringify({
          ...manifest, lockfileVersion: 3, requires: true, packages,
        }));
        const allowlist = JSON.parse(readFileSync(join(REPO_ROOT, ".github/audit-allowlist.json"), "utf8"));
        writeFileSync(join(f.root, ".github/audit-allowlist.json"), JSON.stringify({
          policy: ALLOWLIST_POLICY, entries: allowlist.entries.filter((entry: { package: string }) => entry.package === "uuid"),
        }));
        const run = await runProcess(process.execPath, [
          join(f.root, "scripts/audit-gate.mjs"),
          ...prefixArgs((input) => (input.source === "npm-install-adk" ? adkPrefix : f.prefixes[input.source]!)),
        ], f.root, f.env, GATE_TIMEOUT_MS);
        expect(run.timedOut).toBe(false);
        expect(run.stderr).not.toContain("FAILED TO RUN");
        expect(run.status).toBe(outside || version !== "9.0.1" ? 1 : 0);
        expect(npmRegistry.requests).toContain(BULK_REQUEST);
        if (outside) {
          expect(run.stdout).toContain('node "node_modules/uuid" is outside the dependency chain');
          expect(run.stdout).not.toContain(PASS_MARKER);
        } else if (version !== "9.0.1") {
          expect(run.stdout).toContain(`installed version ${version} differs from allowlist version 9.0.1`);
          expect(run.stdout).not.toContain(PASS_MARKER);
        } else {
          expect(run.stdout).toContain(PASS_MARKER);
        }
      } finally {
        await Promise.all([bunRegistry.close(), npmRegistry.close()]);
      }
    }, CASE_BUDGET_MS);
  }
});

describe("prefix identity against real npm installs (flair#2757)", () => {
  /** Deadline for one npm command run while building the real installs. */
  const NPM_TIMEOUT_MS = 30_000;
  const UNRELATED = "clean-fixture";

  function npm(args: string[], cwd: string, env: Record<string, string>): void {
    const res = spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout: NPM_TIMEOUT_MS });
    if (res.status !== 0) {
      throw new Error(`npm ${args[0]} in ${cwd} exited ${res.status}: ${res.error?.message ?? res.stderr}`);
    }
  }

  /**
   * For each input's package, and for one unrelated package, a dependency-free
   * copy at the fixture version, packed by one real `npm pack` and installed by
   * a real `npm install --ignore-scripts --omit=dev --offline` into its own
   * prefix. Returns each package's prefix.
   */
  function realInstalls(f: Fixture): Record<string, string> {
    const pkgs = [...CONSUMER_INPUTS.map((input) => input.pkg), UNRELATED];
    const packed = join(f.root, "packed");
    mkdirSync(packed);
    const sources = pkgs.map((pkg) => {
      const dir = join(f.root, "pkgsrc", tarballStem(pkg));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: FIXTURE_VERSION }));
      return dir;
    });
    npm(["pack", "--ignore-scripts", "--pack-destination", packed, ...sources], f.root, f.env);
    const prefixes: Record<string, string> = {};
    for (const pkg of pkgs) {
      const prefix = join(f.root, "real", tarballStem(pkg));
      mkdirSync(prefix, { recursive: true });
      writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
      npm(
        ["install", "--ignore-scripts", "--omit=dev", "--offline", "--no-audit", "--no-fund",
          join(packed, `${tarballStem(pkg)}-${FIXTURE_VERSION}.tgz`)],
        prefix,
        f.env,
      );
      prefixes[pkg] = prefix;
    }
    return prefixes;
  }

  /** Run the gate with `pick` choosing each flag's prefix from the real installs; both registries answer clean. */
  async function identityCase(pick: (real: Record<string, string>, input: (typeof CONSUMER_INPUTS)[number]) => string) {
    const bunRegistry = await startRegistry("clean");
    const npmRegistry = await startRegistry("clean");
    try {
      const f = makeFixture({ bunRegistry: bunRegistry.url, npmRegistry: npmRegistry.url });
      const real = realInstalls(f);
      const run = await runProcess(
        process.execPath,
        [join(f.root, "scripts", "audit-gate.mjs"), ...prefixArgs((input) => pick(real, input))],
        f.root,
        f.env,
        GATE_TIMEOUT_MS,
      );
      return { run, real, bunRequests: [...bunRegistry.requests], npmRequests: [...npmRegistry.requests] };
    } finally {
      await Promise.all([bunRegistry.close(), npmRegistry.close()]);
    }
  }

  const MCP = "@tpsdev-ai/flair-mcp";
  const PI = "@tpsdev-ai/pi-flair";
  const own = (real: Record<string, string>, input: (typeof CONSUMER_INPUTS)[number]) => real[input.pkg]!;

  function expectRefusedBeforeAudits(c: Awaited<ReturnType<typeof identityCase>>, ...lines: string[]): void {
    expect(c.run.timedOut).toBe(false);
    expect(c.run.status).toBe(2);
    for (const line of lines) expect(c.run.stderr).toContain(line);
    expect(c.run.stdout).toBe("");
    expect(c.bunRequests).toEqual([]);
    expect(c.npmRequests).toEqual([]);
  }

  it(
    "passes when each flag names a real npm install of its own package",
    async () => {
      const c = await identityCase(own);
      expect(c.run.timedOut).toBe(false);
      expect(c.run.status).toBe(0);
      expect(c.run.stdout).toContain(PASS_MARKER);
      expect(c.npmRequests).toContain(BULK_REQUEST);
    },
    CASE_BUDGET_MS,
  );

  it(
    "exits 2 naming both flags when two packages' prefixes are exchanged",
    async () => {
      const c = await identityCase((real, input) =>
        input.pkg === MCP ? real[PI]! : input.pkg === PI ? real[MCP]! : own(real, input));
      expectRefusedBeforeAudits(
        c,
        `--mcp-npm-install-prefix ${c.real[PI]} is not an npm install of the packed ${MCP}@${FIXTURE_VERSION}`,
        `found direct dependencies ${PI}`,
        `--pi-npm-install-prefix ${c.real[MCP]} is not an npm install of the packed ${PI}@${FIXTURE_VERSION}`,
        `found direct dependencies ${MCP}`,
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "exits 2 when a flag names a clean install of an unrelated package",
    async () => {
      const c = await identityCase((real, input) => (input.pkg === MCP ? real[UNRELATED]! : own(real, input)));
      expectRefusedBeforeAudits(
        c,
        `--mcp-npm-install-prefix ${c.real[UNRELATED]} is not an npm install of the packed ${MCP}@${FIXTURE_VERSION}`,
        `found direct dependencies ${UNRELATED}`,
      );
    },
    CASE_BUDGET_MS,
  );

  it(
    "exits 2 when two flags name the same real prefix",
    async () => {
      const c = await identityCase((real, input) => (input.pkg === PI ? real[MCP]! : own(real, input)));
      expectRefusedBeforeAudits(c, "--mcp-npm-install-prefix and --pi-npm-install-prefix name the same prefix");
    },
    CASE_BUDGET_MS,
  );
});

describe("what the pinned bun prints for each registry answer (flair#2278)", () => {
  async function bunAudit(choice: RegistryChoice, bunLockfile = true): Promise<Run> {
    const registry = await registryFor(choice);
    try {
      const f = makeFixture({ bunRegistry: registry.url, npmRegistry: registry.url, bunLockfile });
      return await runProcess(process.execPath, ["audit", "--json"], f.root, f.env, TOOL_TIMEOUT_MS);
    } finally {
      await registry.close();
    }
  }

  it(
    "prints {} and exits 0 when the registry lists no advisories",
    async () => {
      const run = await bunAudit("clean");
      expect(run.timedOut).toBe(false);
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("{}");
    },
    CASE_BUDGET_MS,
  );

  for (const failure of FAILURES) {
    it(
      `exits non-zero and does not print {} on ${failure.name}`,
      async () => {
        const run = await bunAudit(failure.choice, failure.lockfile);
        expect(run.timedOut).toBe(false);
        expect(run.status).not.toBe(0);
        expect(run.stdout.trim()).not.toBe("{}");
      },
      CASE_BUDGET_MS,
    );
  }
});
