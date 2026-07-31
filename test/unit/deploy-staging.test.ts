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
import { OAUTH_METADATA_PATH, resolveDeployPublicUrl, stageDeployRoot, verifyPublicIssuer } from "../../src/deploy.js";

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
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.0.0-test" }));
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

  test("an operator's own FLAIR_PUBLIC_URL is deployed unchanged, with nothing staged", async () => {
    const root = makePackageRoot();
    writeFileSync(join(root, COMPONENT_ENV_FILENAME), "FLAIR_PUBLIC_URL=https://cdn.example.com\n");

    const staged = stageDeployRoot(root, "https://cluster.org.harperfabric.com");
    cleanups.push(staged.cleanup);

    expect(staged.dir).toBe(root); // nothing copied at all
    expect(staged.plan.action).toBe("operator-value-kept");
    expect(readEnvValue(await packedEnvText(root), PUBLIC_URL_KEY)).toBe("https://cdn.example.com");
  });

  test("a loopback target stages nothing and ships no generated .env", async () => {
    const root = makePackageRoot();
    const staged = stageDeployRoot(root, resolveDeployPublicUrl("http://127.0.0.1:9925"));
    cleanups.push(staged.cleanup);

    expect(staged.dir).toBe(root);
    expect(staged.plan.action).toBe("unchanged");
    expect(await packedEnvText(root)).toBeNull();
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
