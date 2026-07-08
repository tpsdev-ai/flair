// Mixed-version federation compatibility (flair#638).
//
// Every rollout puts the fleet in a temporarily mixed-version state (origin
// upgraded before peers, or one host ahead of the cluster). Federation
// between adjacent versions has never been tested — this file is that test.
//
// It spawns TWO real, independent Harper+Flair instances:
//   - Instance A: the PREVIOUS PUBLISHED `@tpsdev-ai/flair` — installed fresh
//     from the public npm registry via `npm install @tpsdev-ai/flair@latest`
//     into a throwaway temp directory. "Previous published" here means
//     "whatever npm's `latest` dist-tag resolves to at run time" — this is
//     NOT necessarily semver N-1 of HEAD (e.g. right after a release, HEAD
//     and npm-latest are the SAME version, and this suite still runs — it's
//     exercising the real pairing/sync wire protocol either way, just without
//     an actual version skew that particular run).
//   - Instance B: the CURRENT BUILD — this worktree's own `dist/`, loaded as
//     a Harper component exactly the way test/integration/*.test.ts does via
//     `startHarper()`. Requires `bun run build && bun run build:cli` to have
//     already run (same ordering test-integration's CI job already uses).
//
// It pairs them RECIPROCALLY (see "why reciprocal pairing" below) and drives
// the ENTIRE flow through each instance's OWN CLI binary — A's calls always
// go through A's npm-installed `dist/cli.js`, B's calls always go through
// B's freshly-built `dist/cli.js`. This is deliberate: the point of a
// mixed-version test is to prove OLD's wire format is accepted by NEW's
// receiver and vice versa, so the two sides must never share code.
//
// ─── Why reciprocal pairing (two pair operations, not one) ─────────────────
// `POST /FederationSync` (resources/Federation.ts) is PUSH-ONLY and
// one-directional per call: a spoke pushes its own new/updated rows up to
// its configured hub; the hub's response never contains records to merge
// back. There is no pull endpoint anywhere in this codebase (verified by
// reading resources/Federation.ts and every "federation"-tagged CLI command
// in src/cli.ts — grepping for "pull" in a federation context returns
// nothing). `flair federation pair <hub-url>` also always declares the
// CALLER as "spoke" (hardcoded in the CLI's pair action) and, on success,
// unconditionally records the target as "hub" in the caller's OWN local Peer
// table. So to get data flowing BOTH ways with only this push primitive, each
// instance must independently pair AS A SPOKE OF THE OTHER:
//   - B pairs against A (using a token A mints)  → B's local Peer[A] = hub
//     → `B`'s `federation sync` now pushes B's writes to A.
//   - A pairs against B (using a SEPARATE token B mints) → A's local
//     Peer[B] = hub → `A`'s `federation sync` now pushes A's writes to B.
// Two independent pairings, two independent tokens, two independent
// `federation sync` invocations — exactly mirroring how a real 2-node mesh
// would be wired by an operator.
//
// ─── Scope note: "presence" is NOT federated in this codebase ──────────────
// The originating issue (flair#638) asks for a round-trip suite covering
// "sync, presence, memory replication" in both directions. Presence
// (resources/Presence.ts) is a purely LOCAL Ed25519-heartbeat table — it has
// zero references to Federation/Peer/sync, and the hardcoded table list
// `runFederationSyncOnce` pushes (`["Memory", "Soul", "Agent",
// "Relationship"]`, src/cli.ts) does not include Presence. There is no
// cross-instance presence propagation to test because the feature doesn't
// exist yet. Faking a presence round-trip here would be exactly the
// "fake-green job" this issue explicitly warns against. Instead, the
// presence test below verifies presence heartbeats keep working
// INDEPENDENTLY on each mixed-version instance (i.e. mixed-version pairing
// doesn't regress the local presence feature) and documents this gap inline
// — federating presence would be a separate, real feature, not a test fix.
//
// ─── Memory.visibility gotcha (read this before touching the marker writes) ─
// `flair memory add`'s default durability ("standard") defaults
// Memory.visibility to "private" server-side (resources/Memory.ts
// defaultVisibilityForDurability: only "permanent"/"persistent" default to
// "shared"). `runFederationSyncOnce` explicitly EXCLUDES
// `visibility === "private"` Memory rows from every push (src/cli.ts
// isFederationPrivateVisibility, federation-edge-hardening slice 2). A plain
// `memory add` would therefore never leave its origin instance — the marker
// writes below pass `--visibility shared` explicitly for exactly this
// reason.
//
// ─── HOME isolation ──────────────────────────────────────────────────────
// Every `flair` CLI invocation below is spawned as its own subprocess with
// an explicit, per-instance `HOME` env var (never by mutating
// `process.env.HOME` in this test's own process) — Bun's `os.homedir()`
// ignores live `process.env.HOME` mutation, so isolating HOME any other way
// would leak into (or read from) this machine's real `~/.flair` — which, on
// a dev box, can be an actual running Flair install. See
// resolveInstanceEnv() below.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const NODE_BIN = process.env.NODE_BIN ?? "node";

// Generous but bounded — a fresh `npm install` from the public registry plus
// two real Harper installs/boots easily takes 1-3 minutes on a cold cache.
const SETUP_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 45_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

interface Instance {
  label: "A (npm baseline)" | "B (HEAD build)";
  harper: HarperInstance;
  home: string;
  cliPath: string;
  adminPass: string;
  agentId: string;
}

/** Strip CI secrets from the inherited env before handing it to a child
 * process — same deny-list rationale as harper-lifecycle.ts's baseEnv
 * (Sherlock review on #467): a spawned `flair` CLI has no need for
 * GITHUB_TOKEN/NPM_TOKEN, and a crash dump of its env must never carry them.
 */
function sanitizedParentEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.GITHUB_TOKEN;
  delete env.NPM_TOKEN;
  return env;
}

function resolveInstanceEnv(inst: Instance): Record<string, string> {
  return {
    ...sanitizedParentEnv(),
    HOME: inst.home,
    FLAIR_URL: inst.harper.httpURL,
    FLAIR_ADMIN_PASS: inst.adminPass,
  };
}

/** Spawn `node <cliPath> ...args` and wait for it to exit. Rejects (with the
 * full captured stdout/stderr in the error message) on a non-zero exit code
 * or timeout — a silent/partial failure here must not be swallowed, since
 * the whole point of this suite is to fail loudly when mixed-version
 * federation breaks.
 */
async function runFlairCli(
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = CLI_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(
        `flair CLI timed out after ${timeoutMs}ms: ${args.join(" ")}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      ));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `flair CLI exited ${code}: ${args.join(" ")}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Retry an async check until it stops throwing/returning false, absorbing
 * eventual-consistency lag between a federation push and its read-visibility
 * (same rationale as test/e2e-cli.sh's retry_until — a single immediate read
 * after a write/sync is a race, not a guarantee).
 */
async function retryUntil<T>(
  fn: () => Promise<T>,
  check: (value: T) => boolean,
  { attempts = 10, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let last: T | undefined;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await fn();
      if (check(last)) return last;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `retryUntil: condition not met after ${attempts} attempts. ` +
    `Last value: ${JSON.stringify(last)}. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Bootstrap the `flair_pair_initiator` Harper role that `federation token`
 * requires (its `add_user role=flair_pair_initiator` 400s without it — see
 * test/integration/flair-pair-initiator-role.test.ts, which regression-guards
 * this exact function against real Harper). Imported LIVE from each
 * instance's own `dist/cli.js` — not reimplemented here — because the
 * canonical permission spec (PAIR_INITIATOR_PERMISSION) is internal/unexported;
 * the only faithful way to reuse it is to call the real function each
 * version ships. Deliberately called directly (no subprocess): it takes
 * opsUrl/adminUser/adminPass as explicit params and never touches
 * `homedir()`, so it doesn't trip the HOME-isolation hard rule above.
 */
async function ensurePairInitiatorRole(cliPath: string, opsUrl: string, adminPass: string): Promise<void> {
  const mod = await import(pathToFileURL(cliPath).href);
  if (typeof mod.ensureFlairPairInitiatorRole !== "function") {
    throw new Error(
      `${cliPath} does not export ensureFlairPairInitiatorRole() — this baseline's federation ` +
      `pairing bootstrap has changed shape and this compat suite needs updating for it.`,
    );
  }
  await mod.ensureFlairPairInitiatorRole(opsUrl, "admin", adminPass);
}

async function mintPairingToken(inst: Instance, tokenFilePath: string): Promise<void> {
  const { stdout } = await runFlairCli(
    inst.cliPath,
    ["federation", "token", "--port", String(new URL(inst.harper.httpURL).port),
      "--ops-port", String(new URL(inst.harper.opsURL).port), "--admin-pass", inst.adminPass, "--ttl", "30"],
    resolveInstanceEnv(inst),
  );
  // federation token's --format json (default) prints ONLY the JSON blob —
  // no interleaved log lines — so this is safe to parse directly.
  const parsed = JSON.parse(stdout.trim());
  await writeFile(tokenFilePath, JSON.stringify(parsed), "utf-8");
}

async function pairAsSpokeOf(spoke: Instance, hub: Instance, tokenFilePath: string): Promise<{ stdout: string }> {
  return await runFlairCli(
    spoke.cliPath,
    ["federation", "pair", hub.harper.httpURL,
      "--port", String(new URL(spoke.harper.httpURL).port),
      "--ops-port", String(new URL(spoke.harper.opsURL).port),
      "--admin-pass", spoke.adminPass,
      "--token-from", tokenFilePath],
    resolveInstanceEnv(spoke),
  );
}

async function runSync(inst: Instance): Promise<{ stdout: string; stderr: string }> {
  return await runFlairCli(
    inst.cliPath,
    ["federation", "sync",
      "--port", String(new URL(inst.harper.httpURL).port),
      "--ops-port", String(new URL(inst.harper.opsURL).port),
      "--admin-pass", inst.adminPass],
    resolveInstanceEnv(inst),
  );
}

async function addMemory(inst: Instance, content: string): Promise<void> {
  await runFlairCli(
    inst.cliPath,
    ["memory", "add", content, "--agent", inst.agentId, "--durability", "permanent", "--visibility", "shared"],
    resolveInstanceEnv(inst),
  );
}

/**
 * Read back an agent's Memory rows via the Harper OPERATIONS API directly
 * (raw `search_by_value`, Basic admin auth), NOT via `flair memory search`
 * (which goes through the HTTP REST `/SemanticSearch` resource and this
 * repo's own `api()` client helper).
 *
 * This is a deliberate choice, not a shortcut: `api()`'s admin-Basic-auth
 * branch had a real behavioral difference between the npm baseline and HEAD
 * discovered while writing this test — the currently-published baseline
 * (npm dist-tag `latest`) predates flair#634 landing on `main`, so its `api()`
 * skips Basic auth entirely for any 127.0.0.1/localhost target and falls
 * through to per-agent Ed25519 lookup, which fails outright when asked to
 * search an agent whose key isn't present on THIS instance (exactly the
 * cross-instance case this suite exercises) — reproducibly a 403 from
 * `/SemanticSearch`'s allowCreate gate. That is a real, useful finding about
 * `flair memory search`'s CLI-level auth resolution (worth its own
 * regression test upstream), but it is orthogonal to federation sync/pairing
 * — the thing this suite is actually gating on — so using it as the
 * round-trip's read side would make an unrelated CLI quirk fail this job.
 * The ops API's Basic-auth requirement, by contrast, has been stable and
 * unconditional across versions ("does NOT honor authorizeLocal — it always
 * requires Basic admin auth", src/cli.ts loadInstanceSecretKey's comment) —
 * exactly the same mechanism `runFederationSyncOnce` itself uses to read
 * rows to push, making this the version-stable way to verify "did the
 * record actually land", independent of either side's HTTP REST client bugs.
 */
async function fetchAgentMemories(inst: Instance, agentId: string): Promise<any[]> {
  const auth = "Basic " + Buffer.from(`admin:${inst.adminPass}`).toString("base64");
  const res = await fetch(`${inst.harper.opsURL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      operation: "search_by_value",
      schema: "flair",
      table: "Memory",
      search_attribute: "agentId",
      search_value: agentId,
      get_attributes: ["*"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`ops search_by_value(Memory, agentId=${agentId}) on ${inst.label} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return await res.json() as any[];
}

describe("federation mixed-version compat (npm baseline vs HEAD build) [flair#638]", () => {
  let baselineDir: string;
  let a: Instance;
  let b: Instance;
  let tokenDir: string;

  beforeAll(async () => {
    // ── 1. Install the previous published baseline from npm ──────────────
    baselineDir = await mkdtemp(join(tmpdir(), "flair-compat-baseline-"));
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["init", "-y"], { cwd: baselineDir, env: sanitizedParentEnv() });
      let out = "";
      proc.stdout?.on("data", (d) => out += d.toString());
      proc.stderr?.on("data", (d) => out += d.toString());
      proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm init failed: ${out}`)));
      proc.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install", "@tpsdev-ai/flair@latest"], { cwd: baselineDir, env: sanitizedParentEnv() });
      let out = "";
      proc.stdout?.on("data", (d) => out += d.toString());
      proc.stderr?.on("data", (d) => out += d.toString());
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`npm install timed out after ${NPM_INSTALL_TIMEOUT_MS}ms:\n${out}`)); }, NPM_INSTALL_TIMEOUT_MS);
      proc.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`npm install @tpsdev-ai/flair@latest failed:\n${out}`)); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    // Linux CI has no native embedding binary for the npm-published package's
    // own optionalDependencies resolution (only relevant platform variants
    // install automatically) — install it explicitly so Harper's embeddings
    // component doesn't crash the baseline instance at boot. Harmless no-op
    // on a platform (e.g. this test running locally on macOS) that already
    // resolved its own optional variant.
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("npm", ["install", "--no-save", "@node-llama-cpp/linux-x64@3"], { cwd: baselineDir, env: sanitizedParentEnv() });
        let out = "";
        proc.stdout?.on("data", (d) => out += d.toString());
        proc.stderr?.on("data", (d) => out += d.toString());
        proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`native embedding binary install failed:\n${out}`)));
        proc.on("error", reject);
      });
    }

    const pkgDirA = join(baselineDir, "node_modules", "@tpsdev-ai", "flair");

    // ── 2. Start both Harper instances ────────────────────────────────────
    // A: baseline component + baseline's own bundled @harperfast/harper.
    // B: this worktree's component + this worktree's @harperfast/harper —
    // identical to how every other test/integration/*.test.ts spawns Harper
    // (startHarper() with no args), per the issue's "the repo's normal
    // integration-test path" instruction.
    const [harperA, harperB] = await Promise.all([
      startHarper({ cwd: pkgDirA, harperBinDir: baselineDir }),
      startHarper(),
    ]);

    // HOME is the SAME directory harper-lifecycle.ts started each Harper
    // server process with (harper.installDir, its own throwaway mkdtemp) —
    // NOT a fresh, unrelated temp dir. This matters: `GET /FederationInstance`
    // self-provisions an Ed25519 instance keypair SERVER-SIDE and stores the
    // private seed via src/keystore.ts, which is itself HOME-relative
    // (~/.flair/keys/<instanceId>.key) resolved against the SERVER process's
    // own `homedir()` — i.e. wherever harper-lifecycle pointed HOME for that
    // Harper process. `federation pair`/`federation sync` (both of which sign
    // requests with the instance's own key, via loadInstanceSecretKey) run as
    // SEPARATE CLI subprocesses and can only find that seed if their HOME
    // matches the server's. (Discovered by running this test: pointing the
    // CLI at an unrelated HOME reproducibly failed pairing with "No private
    // key found for instance ...".) Every other CLI call (agent add, memory
    // add/search, presence set, federation token/status) doesn't need the
    // instance's OWN key and would work with any isolated HOME, but sharing
    // one HOME per instance for everything is simpler and matches how a real
    // deployment's Harper server + `flair` CLI always share one real $HOME.
    a = { label: "A (npm baseline)", harper: harperA, home: harperA.installDir, cliPath: join(pkgDirA, "dist", "cli.js"), adminPass: harperA.admin.password, agentId: "compat-agent-a" };
    b = { label: "B (HEAD build)", harper: harperB, home: harperB.installDir, cliPath: join(process.cwd(), "dist", "cli.js"), adminPass: harperB.admin.password, agentId: "compat-agent-b" };

    tokenDir = await mkdtemp(join(tmpdir(), "flair-compat-tokens-"));

    // ── 3. Force self-provisioning of each instance's OWN federation
    // identity before any pairing is attempted. `GET /FederationInstance`
    // self-provisions (generates the Ed25519 instance keypair + `Instance`
    // row) on first call — but `POST /FederationPair`'s handler
    // (resources/Federation.ts) looks up the HUB's own Instance row via
    // `databases.flair.Instance.search()` and returns `instance: null` if
    // none exists yet; it does NOT self-provision on the hub's behalf.
    // Discovered empirically: pairing B against A (below) returned
    // `instance: null` the first time, and the CLI's pairing client falls
    // back to a literal `"hub"` string for the local Peer id when that
    // happens — silently wrong, not a crash. A real deployment's
    // `flair init --remote` triggers this provisioning as a side effect;
    // since this harness bypasses `flair init` (to avoid its darwin-only
    // launchd side effect — see the harness-wide note above), replicate the
    // effect directly.
    //
    // Uses explicit Basic admin auth, NOT a bare unauthenticated fetch —
    // another version difference found while writing this test: baseline's
    // `/FederationInstance` accepts Harper's forged-local-super_user with no
    // Authorization header at all, but HEAD's does not (a bare fetch gets a
    // real 403 `AccessViolation` on HEAD specifically). That is consistent
    // with the "gate on verifyAgentRequest, not resolveAgentAuth's ambient
    // super_user" hardening for credential-less loopback requests that
    // landed on `main` after 0.21.0 shipped — see the same "main has commits
    // the published baseline doesn't yet" gap documented on
    // fetchAgentMemories below. Explicit admin Basic auth satisfies both.
    for (const inst of [a, b]) {
      const auth = "Basic " + Buffer.from(`admin:${inst.adminPass}`).toString("base64");
      const res = await fetch(`${inst.harper.httpURL}/FederationInstance`, { headers: { Authorization: auth } });
      if (!res.ok) {
        throw new Error(`GET /FederationInstance on ${inst.label} failed to self-provision: ${res.status} ${await res.text().catch(() => "")}`);
      }
    }

    // ── 4. Register an agent on each instance (also exercises the Agent
    // table's own federation-sync path, and is required for `presence set`'s
    // Ed25519 key). ──────────────────────────────────────────────────────
    for (const inst of [a, b]) {
      await runFlairCli(
        inst.cliPath,
        ["agent", "add", inst.agentId, "--admin-pass", inst.adminPass,
          "--port", String(new URL(inst.harper.httpURL).port),
          "--ops-port", String(new URL(inst.harper.opsURL).port)],
        resolveInstanceEnv(inst),
      );
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // stopHarper() removes each instance's installDir (== .home) itself.
    // Generous timeout: recursively removing baselineDir's ~1700-package
    // node_modules tree alone can exceed bun's default 5s hook timeout.
    if (a?.harper) await stopHarper(a.harper);
    if (b?.harper) await stopHarper(b.harper);
    if (tokenDir) await rm(tokenDir, { recursive: true, force: true });
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  }, 120_000);

  test("both instances are up and healthy", async () => {
    const resA = await fetch(`${a.harper.httpURL}/Health`);
    const resB = await fetch(`${b.harper.httpURL}/Health`);
    // Any real HTTP response (even a 401 from an auth-gated /Health, which is
    // fine here) proves the process is alive and serving — matching
    // harper-lifecycle's own "status > 0" liveness definition.
    expect(resA.status).toBeGreaterThan(0);
    expect(resB.status).toBeGreaterThan(0);
  }, CLI_TIMEOUT_MS);

  test("reciprocal federation pairing succeeds in both directions", async () => {
    await ensurePairInitiatorRole(a.cliPath, a.harper.opsURL, a.adminPass);
    await ensurePairInitiatorRole(b.cliPath, b.harper.opsURL, b.adminPass);

    // Round 1: B pairs as a spoke of A → B can now push to A.
    const tokenFromA = join(tokenDir, "token-from-a.json");
    await mintPairingToken(a, tokenFromA);
    const pairBtoA = await pairAsSpokeOf(b, a, tokenFromA);
    expect(pairBtoA.stdout).toContain("Paired with hub");

    // Round 2: A pairs as a spoke of B → A can now push to B.
    const tokenFromB = join(tokenDir, "token-from-b.json");
    await mintPairingToken(b, tokenFromB);
    const pairAtoB = await pairAsSpokeOf(a, b, tokenFromB);
    expect(pairAtoB.stdout).toContain("Paired with hub");
  }, CLI_TIMEOUT_MS * 4);

  test("memory written on A (npm baseline) replicates to B (HEAD build) via sync", async () => {
    const marker = `compat-marker-a-to-b-${Date.now()}`;
    await addMemory(a, `mixed-version federation compat marker: ${marker}`);
    await runSync(a); // A pushes to its hub, B (paired in round 2 above)

    const rows = await retryUntil(
      () => fetchAgentMemories(b, a.agentId),
      (rows) => rows.some((r) => String(r.content ?? "").includes(marker)),
    );
    expect(rows.some((r) => String(r.content ?? "").includes(marker))).toBe(true);
  }, CLI_TIMEOUT_MS * 6);

  test("memory written on B (HEAD build) replicates to A (npm baseline) via sync", async () => {
    const marker = `compat-marker-b-to-a-${Date.now()}`;
    await addMemory(b, `mixed-version federation compat marker: ${marker}`);
    await runSync(b); // B pushes to its hub, A (paired in round 1 above)

    const rows = await retryUntil(
      () => fetchAgentMemories(a, b.agentId),
      (rows) => rows.some((r) => String(r.content ?? "").includes(marker)),
    );
    expect(rows.some((r) => String(r.content ?? "").includes(marker))).toBe(true);
  }, CLI_TIMEOUT_MS * 6);

  test("federation status reports both peers as paired with no errors", async () => {
    for (const inst of [a, b]) {
      const { stdout } = await runFlairCli(
        inst.cliPath,
        ["federation", "status", "--json",
          "--port", String(new URL(inst.harper.httpURL).port)],
        resolveInstanceEnv(inst),
      );
      const status = JSON.parse(stdout.trim());
      expect(Array.isArray(status.peers)).toBe(true);
      expect(status.peers.length).toBeGreaterThan(0);
      // The peer this instance syncs TO must have actually merged data by
      // now (lastMergeAt set) — not just been contacted (lastSyncAt) — see
      // Federation.ts's Peer schema doc on the merge-vs-contact distinction.
      const hubPeer = status.peers.find((p: any) => p.role === "hub");
      expect(hubPeer).toBeDefined();
      expect(hubPeer.lastMergeAt).toBeTruthy();
    }
  }, CLI_TIMEOUT_MS * 2);

  test("presence heartbeats work independently on each mixed-version instance (NOT federated — see file header)", async () => {
    // Presence is local-only in this codebase today (no Peer/sync
    // involvement anywhere in resources/Presence.ts, and Presence isn't in
    // runFederationSyncOnce's synced-table list) — federation pairing must
    // not have broken it on EITHER version, but there is nothing to
    // replicate cross-instance.
    for (const inst of [a, b]) {
      await runFlairCli(
        inst.cliPath,
        ["presence", "set", "--agent", inst.agentId, "--activity", "coding",
          "--task", "mixed-version federation compat check",
          "--port", String(new URL(inst.harper.httpURL).port)],
        resolveInstanceEnv(inst),
      );
      const res = await fetch(`${inst.harper.httpURL}/Presence`);
      expect(res.status).toBe(200);
      const roster = await res.json() as any[];
      const entry = roster.find((r) => r.id === inst.agentId);
      expect(entry).toBeDefined();
      expect(entry.presenceStatus).toBe("active");
    }
  }, CLI_TIMEOUT_MS * 2);
});
