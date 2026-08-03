// deploy-staging.test.ts — does the `.env` actually reach the deployed payload?
// (flair#1005 item 2)
//
// The defect this pins is not "the writer did not run". It is that a writer ran
// and its output went nowhere: `buildDeployTarball` wrote a `.env` into a temp
// directory and then packed an explicit entries list that never contained it, so
// the file was discarded with the directory on every single call since it was
// written. Asserting "the file exists on disk" would have passed throughout.
//
// So every assertion here is made against a PACKED payload, produced by the same
// packer that runs in production:
//
//   - `flair deploy` shells out to `harper deploy`, which packs its own CWD via
//     harper/dist/components/packageComponent.js. That module is imported here
//     directly, so the entry list under test is the entry list harper would send.
//   - `flair init --remote` builds its own tarball via `tar` — covered in
//     test/integration/init-remote-ops.test.ts against a real tarball.
//
// The other half of the proof — that a packed `.env` reaches `process.env` and
// changes what the instance advertises — is test/integration/deploy-public-url.test.ts,
// against a real spawned Harper. Neither half is sufficient alone.

import { describe, test, expect, afterEach } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMPONENT_ENV_FILENAME, PUBLIC_URL_KEY, envKeyNames, readEnvValue } from "../../src/component-env.js";
import { OAUTH_METADATA_PATH, publishedEntryNames, resolveDeployPublicUrl, stageDeployRoot, verifyPublicIssuer } from "../../src/deploy.js";

const require_ = createRequire(import.meta.url);

// harper's real packer — the code that decides what a `harper deploy` uploads.
// Addressed by PATH, not by package specifier: harper's `exports` map does not
// expose its internals, and the same direct-path convention is what
// test/helpers/harper-lifecycle.ts uses to reach `dist/bin/harper.js`.
const REPO_ROOT = join(import.meta.dir, "..", "..");
function harperPackagerPath(): string {
  for (const pkg of ["harper", join("@harperfast", "harper")]) {
    const p = join(REPO_ROOT, "node_modules", pkg, "dist", "components", "packageComponent.js");
    if (existsSync(p)) return p;
  }
  throw new Error("harper's packageComponent.js not found under node_modules — cannot test what a deploy uploads");
}
const { packageDirectory } = require_(harperPackagerPath()) as {
  packageDirectory: (dir: string, opts: { skip_node_modules: boolean; skip_symlinks: boolean }) => Promise<string>;
};

// The options harper's CLI applies to a `deploy` (cliOperations.js: skip_node_modules
// defaults on, skip_symlinks defaults off).
const HARPER_DEPLOY_PACK_OPTS = { skip_node_modules: true, skip_symlinks: false };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-stagetest-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A package root shaped like the published flair package. */
function makePackageRoot(): string {
  const root = tempDir();
  mkdirSync(join(root, "dist", "resources"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  mkdirSync(join(root, "node_modules", "harper"), { recursive: true });
  // `files` mirrors what a real npm-installed @tpsdev-ai/flair carries. The
  // fixture omitted it before, which made it unfaithful to the thing it stands
  // in for — an installed package always declares `files`, and stageDeployRoot
  // now derives the payload from it.
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@tpsdev-ai/flair",
    version: "0.0.0-test",
    files: ["dist/", "schemas/", "templates/", "docs/", "config.yaml", "LICENSE", "README.md", "SECURITY.md"],
  }));
  writeFileSync(join(root, "config.yaml"), "name: flair\nloadEnv:\n  files: '.env'\n");
  writeFileSync(join(root, "dist", "resources", "Memory.js"), "// resource\n");
  writeFileSync(join(root, "schemas", "schema.graphql"), "type Q { a: String }\n");
  writeFileSync(join(root, "node_modules", "harper", "big.bin"), "x".repeat(1024));
  return root;
}

/** Entry names harper would upload for `dir`, sorted. */
async function packedEntries(dir: string): Promise<string[]> {
  const b64 = await packageDirectory(dir, HARPER_DEPLOY_PACK_OPTS);
  const tarPath = join(tempDir(), "payload.tar.gz");
  writeFileSync(tarPath, Buffer.from(b64, "base64"));
  const { list } = await import("tar");
  const names: string[] = [];
  await list({ file: tarPath, onReadEntry: (e: any) => names.push(String(e.path).replace(/^\.\//, "")) });
  return names.filter((n) => n !== "." && n !== "").sort();
}

/** The `.env` content of a packed payload, or null when the payload has none. */
async function packedEnvText(dir: string): Promise<string | null> {
  const b64 = await packageDirectory(dir, HARPER_DEPLOY_PACK_OPTS);
  const out = tempDir();
  const tarPath = join(out, "payload.tar.gz");
  writeFileSync(tarPath, Buffer.from(b64, "base64"));
  const { extract } = await import("tar");
  const dest = join(out, "x");
  mkdirSync(dest, { recursive: true });
  await extract({ file: tarPath, cwd: dest });
  const p = join(dest, COMPONENT_ENV_FILENAME);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

describe("resolveDeployPublicUrl", () => {
  test("a Fabric target is the value to advertise", () => {
    expect(resolveDeployPublicUrl("https://cluster.org.harperfabric.com")).toBe("https://cluster.org.harperfabric.com");
    expect(resolveDeployPublicUrl("https://flair.example.com/")).toBe("https://flair.example.com");
  });

  test("a loopback target supplies nothing", () => {
    expect(resolveDeployPublicUrl("http://127.0.0.1:9925")).toBeNull();
    expect(resolveDeployPublicUrl("http://localhost:9925")).toBeNull();
  });

  test("a value that is not an http(s) URL supplies nothing", () => {
    expect(resolveDeployPublicUrl("not a url")).toBeNull();
    expect(resolveDeployPublicUrl("ftp://example.com")).toBeNull();
    expect(resolveDeployPublicUrl("")).toBeNull();
  });
});

describe("stageDeployRoot — what harper actually uploads", () => {
  test("THE DEFECT: .env is in the packed payload", async () => {
    // Fails on any implementation where the file is written but not packed.
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    const entries = await packedEntries(staged.dir);
    expect(entries).toContain(COMPONENT_ENV_FILENAME);
  });

  test("the packed .env carries FLAIR_PUBLIC_URL and nothing else", async () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    const text = await packedEnvText(staged.dir);
    expect(text).not.toBeNull();
    expect(envKeyNames(text)).toEqual([PUBLIC_URL_KEY]);
    expect(readEnvValue(text, PUBLIC_URL_KEY)).toBe("https://flair.example.com");
  });

  test("the payload is otherwise byte-for-byte the same set of entries", async () => {
    // The staged copy must not quietly drop or add anything else. Compared against
    // harper packing the ORIGINAL root, so a mistake in the copy filter shows up
    // here rather than as a component that is missing a file in production.
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    const before = await packedEntries(root);
    const after = await packedEntries(staged.dir);
    expect(after).toEqual([...before, COMPONENT_ENV_FILENAME].sort());
    // node_modules is excluded by harper itself, so it is absent from both.
    expect(before.some((e) => e.startsWith("node_modules"))).toBe(false);
    expect(after.some((e) => e.startsWith("node_modules"))).toBe(false);
  });

  test("symlinked content survives the staging copy", async () => {
    // harper packs with dereference on, so a symlinked directory contributes its
    // CONTENT to the payload. If staging turned that into a broken link the
    // deployed component would be missing files.
    const root = makePackageRoot();
    const external = tempDir();
    mkdirSync(join(external, "inner"), { recursive: true });
    writeFileSync(join(external, "inner", "linked.txt"), "linked\n");
    symlinkSync(join(external, "inner"), join(root, "templates"));

    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    const after = await packedEntries(staged.dir);
    expect(after).toContain("templates/linked.txt");
  });

  test("does not write into the operator's package root", () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    expect(staged.dir).not.toBe(root);
    expect(existsSync(join(root, COMPONENT_ENV_FILENAME))).toBe(false);
  });

  test("an operator's existing .env is merged, and their file on disk is untouched", async () => {
    const root = makePackageRoot();
    const operatorFile = join(root, COMPONENT_ENV_FILENAME);
    const original = "# operator settings\nFLAIR_MCP_OAUTH=1\n";
    writeFileSync(operatorFile, original);

    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);

    expect(readFileSync(operatorFile, "utf8")).toBe(original);
    const packed = await packedEnvText(staged.dir);
    expect(envKeyNames(packed)).toEqual(["FLAIR_MCP_OAUTH", PUBLIC_URL_KEY]);
  });

  test("an operator's own FLAIR_PUBLIC_URL is carried through untouched", async () => {
    const root = makePackageRoot();
    writeFileSync(join(root, COMPONENT_ENV_FILENAME), "FLAIR_PUBLIC_URL=https://cdn.example.com\n");

    const staged = stageDeployRoot(root, "https://cluster.org.harperfabric.com");
    cleanups.push(staged.cleanup);

    // Staging is now unconditional — the payload filter has to apply whether or
    // not an .env needs writing, or a loopback deploy from a checkout would still
    // ship .git. The operator's own value must survive the copy unmodified.
    expect(staged.dir).not.toBe(root);
    expect(staged.plan.action).toBe("operator-value-kept");
    expect(readEnvValue(await packedEnvText(staged.dir), PUBLIC_URL_KEY)).toBe("https://cdn.example.com");
  });

  test("a loopback target ships no generated .env, but is still filtered", async () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, resolveDeployPublicUrl("http://127.0.0.1:9925"));
    cleanups.push(staged.cleanup);

    // The .env contract is unchanged: a loopback target generates nothing.
    expect(staged.plan.action).toBe("unchanged");
    expect(await packedEnvText(staged.dir)).toBeNull();
    // But the payload is still staged and filtered — this is the case that used
    // to return packageRoot untouched and ship the whole working tree with it.
    expect(staged.dir).not.toBe(root);
    expect(existsSync(join(staged.dir, "node_modules"))).toBe(false);
  });

  test("the staged .env is written 0600", () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    cleanups.push(staged.cleanup);
    const mode = statSync(join(staged.dir, COMPONENT_ENV_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("cleanup removes the staged copy", () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, "https://flair.example.com");
    const dir = staged.dir;
    expect(existsSync(dir)).toBe(true);
    staged.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});

// ─── The post-deploy check that the value actually took effect ───────────────
//
// This one can FAIL a deploy, so its branches are pinned individually. The
// distinction that matters is the last two tests: a document that cannot be read
// must not be reported as a pass, and must not fail the deploy either — it is a
// check that did not run, and it says so.

describe("verifyPublicIssuer", () => {
  const BASE = "https://flair.example.com";

  function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return (async (input: any) => handler(String(input))) as unknown as typeof fetch;
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("passes when the advertised issuer is on the public host", async () => {
    let asked = "";
    const result = await verifyPublicIssuer({
      baseUrl: BASE,
      fetchImpl: fakeFetch((url) => { asked = url; return json({ issuer: BASE }); }),
    });
    expect(asked).toBe(`${BASE}${OAUTH_METADATA_PATH}`);
    expect(result).toEqual({ checked: true, issuer: BASE, detail: `issuer ${BASE}` });
  });

  test("THROWS on a loopback issuer — the flair#1000 symptom, at deploy time", async () => {
    const opts = {
      baseUrl: BASE,
      timeoutMs: 0, // no rolling restart to wait out in a unit test
      fetchImpl: fakeFetch(() => json({ issuer: "http://127.0.0.1:9980" })),
    };
    await expect(verifyPublicIssuer(opts)).rejects.toThrow(/127\.0\.0\.1/);
    // The error has to enable a response: the key, the file, and loadEnv.
    await expect(verifyPublicIssuer(opts)).rejects.toThrow(/FLAIR_PUBLIC_URL/);
    await expect(verifyPublicIssuer(opts)).rejects.toThrow(/loadEnv/);
  });

  test("waits out a rolling restart rather than failing a good deploy", async () => {
    // On a multi-node cluster the request can be answered by a node that has not
    // restarted yet, so the first read can legitimately still be the OLD value.
    // Reading once would fail a deploy that was fine.
    let call = 0;
    const result = await verifyPublicIssuer({
      baseUrl: BASE,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      fetchImpl: fakeFetch(() => {
        call++;
        return json({ issuer: call < 3 ? "http://127.0.0.1:9980" : BASE });
      }),
    });
    expect(result).toEqual({ checked: true, issuer: BASE, detail: `issuer ${BASE}` });
    expect(call).toBe(3);
  });

  test("still fails when the issuer never stops being loopback", async () => {
    // The positive control for the test above: waiting must not become "never fails".
    let call = 0;
    await expect(
      verifyPublicIssuer({
        baseUrl: BASE,
        timeoutMs: 30,
        pollIntervalMs: 1,
        fetchImpl: fakeFetch(() => { call++; return json({ issuer: "http://127.0.0.1:9980" }); }),
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
    expect(call).toBeGreaterThan(1);
  });

  test("a 404 is 'did not run', not a pass and not a failure", async () => {
    const result = await verifyPublicIssuer({
      baseUrl: BASE,
      timeoutMs: 0,
      fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })),
    });
    expect(result.checked).toBe(false);
    expect(result.issuer).toBeNull();
    expect(result.detail).toContain("404");
  });

  test("a document with no issuer is 'did not run'", async () => {
    const result = await verifyPublicIssuer({
      baseUrl: BASE,
      timeoutMs: 0,
      fetchImpl: fakeFetch(() => json({ token_endpoint: `${BASE}/OAuthToken` })),
    });
    expect(result.checked).toBe(false);
    expect(result.detail).toContain("no issuer");
  });

  test("an unreachable endpoint is 'did not run'", async () => {
    const result = await verifyPublicIssuer({
      baseUrl: BASE,
      timeoutMs: 0,
      fetchImpl: fakeFetch(() => { throw new Error("connect ECONNREFUSED"); }),
    });
    expect(result.checked).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

// ─── flair#1020 and the private deploy-payload finding ────────────────────────
//
// harper packs the deploy root wholesale. When that root is an npm-installed
// package the tree IS the published file set, which is the case the original
// design assumed. Deploying from a git CHECKOUT — which our own deploy procedure
// prescribes — silently shipped the entire working tree instead.
//
// Measured on the production Fabric origin 2026-08-03 at v0.36.0: 36 top-level
// entries including .git, .env, models/ (80 MB), test/, packages/ and a scratch
// pr-body.md. 96 MB against a 1.3 MB published tarball.
//
// These tests fail if the payload ever admits a top-level entry the published
// package would not contain.
describe("stageDeployRoot — the payload equals the published file set", () => {
  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "flair-payload-fixture-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "@tpsdev-ai/flair",
      version: "0.0.0-test",
      files: ["dist/", "schemas/", "config.yaml", "README.md"],
      workspaces: ["packages/*"],
    }));
    // published entries
    for (const d of ["dist", "schemas"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "keep.txt"), "published");
    }
    writeFileSync(join(root, "config.yaml"), "published: true");
    writeFileSync(join(root, "README.md"), "# published");
    // entries a checkout carries that MUST NOT ship
    for (const d of [".git", "models", "packages", "test", "src", "scripts"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "secret.txt"), "must not ship");
    }
    writeFileSync(join(root, "pr-body.md"), "scratch file left in the clone");
    writeFileSync(join(root, "bun.lock"), "lock");
    return root;
  }

  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  test("drops every unpublished top-level entry, including .git and models", () => {
    const root = fixtureRoot(); roots.push(root);
    const staged = stageDeployRoot(root, "https://example.invalid");
    const got = new Set(require("node:fs").readdirSync(staged.dir));
    for (const forbidden of [".git", "models", "packages", "test", "src", "scripts", "pr-body.md", "bun.lock"]) {
      expect(got.has(forbidden)).toBe(false);
    }
    staged.cleanup();
  });

  test("keeps every published entry — the filter must not be over-broad", () => {
    const root = fixtureRoot(); roots.push(root);
    const staged = stageDeployRoot(root, "https://example.invalid");
    const got = new Set(require("node:fs").readdirSync(staged.dir));
    for (const kept of ["dist", "schemas", "config.yaml", "README.md", "package.json"]) {
      expect(got.has(kept)).toBe(true);
    }
    // and subtrees survive: only TOP-LEVEL entries are filtered
    expect(existsSync(join(staged.dir, "dist", "keep.txt"))).toBe(true);
    staged.cleanup();
  });

  test("refuses to deploy when files cannot be determined, rather than shipping everything or nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-nofiles-")); roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0" }));
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(() => stageDeployRoot(root, "https://example.invalid")).toThrow(/published file set/);
  });

  test("publishedEntryNames reads files from the root, not a hardcoded copy", () => {
    const root = fixtureRoot(); roots.push(root);
    const names = publishedEntryNames(root);
    expect(names.has("dist")).toBe(true);
    expect(names.has("schemas")).toBe(true);
    expect(names.has("package.json")).toBe(true);
    expect(names.has("models")).toBe(false);
  });
});
