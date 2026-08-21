// deploy-public-url.test.ts — does the value a deploy ships actually change what
// the instance tells the world? (flair#1005 item 2, flair#1000)
//
// flair#1000: a publicly-reachable instance served an OAuth discovery document
// whose issuer and every endpoint were `http://127.0.0.1:9980`, so a remote client
// followed discovery to its own loopback. The fix is `FLAIR_PUBLIC_URL` reaching
// the component's `process.env` — which requires a `.env` inside the deployed
// component AND the `loadEnv` declaration in config.yaml that makes Harper read it
// (flair#1010). Either half missing produces the same silent failure.
//
// This walks the whole chain with production code at every step:
//
//   stageDeployRoot()            the thing `flair deploy` runs
//     → harper's own packer      the code `harper deploy` uploads with
//       → tar extract            what Harper's deployComponent does server-side
//         → a REAL spawned Harper booting that directory as its component
//           → GET /OAuthMetADATA over HTTP
//
// What it does not cover: the HTTPS upload to a Fabric cluster and Harper's
// server-side `npm install`. Nothing about either is specific to this change.
//
// The second test is the positive control. Without it, a green first test proves
// only that /OAuthMetadata returned a string — not that the `.env` is what put it
// there. So the identical tree, built for a target that supplies no public URL,
// must advertise loopback.

import { describe, test, expect, afterAll } from "bun:test";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { resolveDeployPublicUrl, stageDeployRoot } from "../../src/deploy.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_URL = "https://flair-1005.example.com";

const require_ = createRequire(import.meta.url);
function harperPackagerPath(): string {
  for (const pkg of ["harper", join("@harperfast", "harper")]) {
    const p = join(REPO_ROOT, "node_modules", pkg, "dist", "components", "packageComponent.js");
    if (existsSync(p)) return p;
  }
  throw new Error("harper's packageComponent.js not found under node_modules");
}
const { packageDirectory } = require_(harperPackagerPath()) as {
  packageDirectory: (dir: string, opts: { skip_node_modules: boolean; skip_symlinks: boolean }) => Promise<string>;
};

const tmpDirs: string[] = [];
const instances: HarperInstance[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * A package root shaped like the PUBLISHED flair package — the layout
 * `resolvePackageRoot()` hands to a deploy. Deliberately not the repo root: that
 * carries an 80MB pre-downloaded embedding model which a real deploy never packs.
 */
function publishedLikePackageRoot(): string {
  const root = tempDir("flair-pkgroot-");
  for (const entry of ["dist", "schemas", "templates", "docs", "config.yaml", "package.json", "LICENSE", "README.md", "SECURITY.md"]) {
    const src = join(REPO_ROOT, entry);
    if (existsSync(src)) cpSync(src, join(root, entry), { recursive: true });
  }
  return root;
}

/**
 * Run the real deploy path as far as a directory Harper can boot: stage, pack
 * with harper's packer, extract the way Harper's deployComponent does, then
 * provide node_modules (which Harper installs server-side and the packer always
 * excludes).
 */
async function deployedComponentDir(publicUrl: string | null): Promise<string> {
  const packageRoot = publishedLikePackageRoot();
  const staged = stageDeployRoot(packageRoot, publicUrl);
  try {
    const b64 = await packageDirectory(staged.dir, { skip_node_modules: true, skip_symlinks: false });
    const work = tempDir("flair-payload-");
    const tarPath = join(work, "payload.tar.gz");
    writeFileSync(tarPath, Buffer.from(b64, "base64"));

    const componentDir = join(work, "component");
    mkdirSync(componentDir, { recursive: true });
    const { extract } = await import("tar");
    await extract({ file: tarPath, cwd: componentDir });

    symlinkSync(join(REPO_ROOT, "node_modules"), join(componentDir, "node_modules"));
    return componentDir;
  } finally {
    staged.cleanup();
  }
}

async function fetchOAuthMetadata(httpURL: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${httpURL}/OAuthMetadata`, { signal: AbortSignal.timeout(15_000) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("a deployed component advertises the deploy's public URL (flair#1005)", () => {
  test(
    "every discovery URL is on the public host, not 127.0.0.1",
    async () => {
      const componentDir = await deployedComponentDir(PUBLIC_URL);
      const harper = await startHarper({ cwd: componentDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const doc = await fetchOAuthMetadata(harper.httpURL);

      expect(doc.issuer).toBe(PUBLIC_URL);
      for (const key of Object.keys(doc)) {
        if (!key.endsWith("_endpoint")) continue;
        const value = doc[key];
        expect({ key, value }).toEqual({ key, value: expect.stringContaining(PUBLIC_URL) });
      }
      // The literal symptom from flair#1000, asserted against the whole document.
      expect(JSON.stringify(doc)).not.toContain("127.0.0.1");
    },
    240_000,
  );

  test(
    "a value already in the instance's process environment WINS over the shipped file",
    async () => {
      // Harper's loadEnv plugin skips (and warns about) any key already present in
      // process.env unless `override` is declared, and flair's config.yaml declares
      // only `files`. So a Fabric-level environment setting outranks the payload:
      // a deploy cannot silently replace configuration the operator set on the
      // instance itself. That is a claim the docs make, so it is measured here
      // rather than read off harper's source.
      const OPERATOR_URL = "https://operator-set.example.com";
      const componentDir = await deployedComponentDir(PUBLIC_URL);
      const prev = process.env.FLAIR_PUBLIC_URL;
      process.env.FLAIR_PUBLIC_URL = OPERATOR_URL;
      let harper;
      try {
        harper = await startHarper({ cwd: componentDir, harperBinDir: REPO_ROOT });
      } finally {
        if (prev === undefined) delete process.env.FLAIR_PUBLIC_URL;
        else process.env.FLAIR_PUBLIC_URL = prev;
      }
      instances.push(harper);

      const doc = await fetchOAuthMetadata(harper.httpURL);
      expect(doc.issuer).toBe(OPERATOR_URL);
    },
    240_000,
  );

  test(
    "POSITIVE CONTROL: the same tree with no shipped .env advertises loopback",
    async () => {
      // resolveDeployPublicUrl returns null for a loopback target, so stageDeployRoot
      // generates nothing — the pre-flair#1005 payload. If this ALSO advertised the
      // public URL, the test above would be measuring something other than the file.
      const componentDir = await deployedComponentDir(resolveDeployPublicUrl("http://127.0.0.1:9925"));
      expect(existsSync(join(componentDir, ".env"))).toBe(false);

      const harper = await startHarper({ cwd: componentDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const doc = await fetchOAuthMetadata(harper.httpURL);
      expect(String(doc.issuer)).toContain("127.0.0.1");
    },
    240_000,
  );
});
