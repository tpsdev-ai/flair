import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, statSync, readdirSync, mkdirSync, cpSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  idpEnvNames, isUnresolvedEnvValue, redirectUriForIssuer, validateRedirectIssuer,
  guardMcpOAuthEnv, planRedirectMigration, describeMcpRedirectFinding,
  readMcpProviderReadiness, readTargetMcpRedirectFinding, renderRedirectMigration,
} from "../../src/lib/mcp-oauth-env.ts";
import { parseMcpComponentEnv } from "../../src/lib/mcp-oauth-env-core.ts";

const REDIRECT = idpEnvNames().redirectUri;
const configured = { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://flair.example.com", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2270-unit-"));
  writeFileSync(join(dir, "config.yaml"), "name: flair\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const envPath = () => join(dir, ".env");
const migrate = (env: Record<string, string | undefined> = configured) => planRedirectMigration({ configPath: join(dir, "config.yaml"), env });

test("copied CLI imports without the harper package", () => {
  const root = join(import.meta.dir, "../..");
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "node_modules"));
  for (const entry of readdirSync(join(root, "node_modules"))) {
    if (entry !== "harper") symlinkSync(join(root, "node_modules", entry), join(dir, "node_modules", entry));
  }
  symlinkSync(join(root, "packages"), join(dir, "packages"));
  writeFileSync(join(dir, "drive.ts"), 'import { program } from "./src/cli.ts"; console.log(program.name());');
  const result = spawnSync(process.execPath, [join(dir, "drive.ts")], { cwd: dir, encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("flair");
}, 15_000);

test.each([
  'export FLAIR_MCP_OAUTH="true" # enabled\r\nFLAIR_MCP_ISSUER: https://flair.example\r\n',
  "OAUTH_GITHUB_CLIENT_ID='client#id'\nOAUTH_GITHUB_CLIENT_SECRET=`secret#value`\n",
  'OAUTH_GITHUB_CLIENT_SECRET="line\\nnext\\rend"\nEMPTY=\nRAW=first # comment\n',
  'OTHER="multiline\nvalue"\nOAUTH_GITHUB_REDIRECT_URI=${OAUTH_GITHUB_REDIRECT_URI}\n',
  "DUP=first\nDUP=second\rCR=third\r\nDOT.KEY=x\nDASH-KEY=y\nINVALID LINE\n",
])("component env parsing matches Harper dotenv: %s", text => {
  const require = createRequire(import.meta.url);
  const harperRequire = createRequire(require.resolve("harper"));
  const dotenv = harperRequire("dotenv") as { parse: (text: string) => Record<string, string> };
  expect(parseMcpComponentEnv(text)).toEqual(dotenv.parse(text));
});

describe("redirect issuer", () => {
  test.each(["https://flair.example.com", "https://flair.example.com/", "https://flair.example.com:8443", "http://127.0.0.1:9926", "http://[::1]:9926", "http://localhost:9926"])("accepts origin %s", issuer => {
    expect(redirectUriForIssuer(issuer)).toBe(`${new URL(issuer).origin}/oauth`);
  });
  test.each([
    ["https://x\\path", "origin-has-path"], ["https://x\\", "origin-has-path"],
    ["https://x/path", "origin-has-path"], ["https://x/path/..", "origin-has-path"],
    ["https://user:pass@x", "origin-has-userinfo"], ["http://public.example", "origin-requires-https"],
    ["https://x?q=1", "origin-has-query"], ["https://x#fragment", "origin-has-fragment"],
    ["ftp://x", "origin-requires-https"], ["not a url", "invalid-origin"],
  ])("refuses %s", (issuer, reason) => {
    expect(validateRedirectIssuer(issuer)).toEqual({ redirect: null, reason });
    const result = migrate({ ...configured, FLAIR_MCP_ISSUER: issuer });
    expect(result.action).toBe("refused");
    expect(renderRedirectMigration(result)).toContain(reason);
    expect(existsSync(envPath())).toBe(false);
  });
  test.each([undefined, "", "   ", "${OAUTH_GITHUB_REDIRECT_URI}"])("missing value %s", value => {
    expect(isUnresolvedEnvValue(value)).toBe(true);
  });
});

describe("provider guard", () => {
  test.each(["true", "false", undefined])("missing redirect with MCP flag %s", flag => {
    const env = { ...configured, FLAIR_MCP_OAUTH: flag };
    const decision = guardMcpOAuthEnv(env);
    expect(decision.degraded).toBe(true);
    expect(decision.reason).toContain(REDIRECT);
    expect(env.OAUTH_GITHUB_CLIENT_ID).toBeUndefined();
    expect(env.OAUTH_GITHUB_CLIENT_SECRET).toBeUndefined();
  });
  test("preserves a configured redirect", () => {
    const env = { ...configured, [REDIRECT]: "https://kept.example/oauth" };
    expect(guardMcpOAuthEnv(env).degraded).toBe(false);
    expect(env.OAUTH_GITHUB_CLIENT_SECRET).toBe("s");
  });
  test("an incomplete credential pair stays unconfigured", () => {
    expect(guardMcpOAuthEnv({ OAUTH_GITHUB_CLIENT_ID: "c" }).degraded).toBe(false);
  });
});

describe("redirect migration files", () => {
  test("stages a redirect from local configuration", () => {
    const result = migrate();
    expect(result.action).toBe("staged");
    expect(readFileSync(envPath(), "utf8")).toBe(`${REDIRECT}=https://flair.example.com/oauth\n`);
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain("flair.example.com");
  });
  test("reads local dotenv issuer and credentials", () => {
    writeFileSync(envPath(), Object.entries(configured).map(([k, v]) => `${k}="${v}" # local\n`).join(""), { mode: 0o640 });
    expect(migrate({}).action).toBe("staged");
    expect(statSync(envPath()).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).sort()).toEqual([".env", "config.yaml"]);
  });
  test("process issuer wins over dotenv; public URL does not supply the issuer", () => {
    writeFileSync(envPath(), "FLAIR_MCP_ISSUER=https://file.example\nFLAIR_PUBLIC_URL=https://public.example\n");
    expect(migrate({ ...configured, FLAIR_PUBLIC_URL: "https://other.example" }).action).toBe("staged");
    expect(readFileSync(envPath(), "utf8")).toContain(`${REDIRECT}=https://flair.example.com/oauth`);
    rmSync(envPath());
    const result = migrate({ ...configured, FLAIR_MCP_ISSUER: undefined, FLAIR_PUBLIC_URL: "https://public.example" });
    expect(result.action).toBe("no-issuer");
    expect(renderRedirectMigration(result)).toBe(`MCP OAuth: ${REDIRECT} is missing and FLAIR_MCP_ISSUER is missing — set ${REDIRECT} in the instance environment, or re-run: flair mcp enable`);
  });
  test("requires enablement and both credentials", () => {
    expect(migrate({}).action).toBe("not-enabled");
    expect(migrate({ ...configured, FLAIR_MCP_OAUTH: "false" }).action).toBe("not-enabled");
    expect(migrate({ ...configured, OAUTH_GITHUB_CLIENT_SECRET: undefined }).action).toBe("no-credentials");
    expect(migrate({ ...configured, OAUTH_GITHUB_CLIENT_ID: "${CLIENT}" }).action).toBe("no-credentials");
    expect(existsSync(envPath())).toBe(false);
  });
  test.each(["", "${OAUTH_GITHUB_REDIRECT_URI}"])("replaces missing dotenv redirect %s", value => {
    writeFileSync(envPath(), `${REDIRECT}=${value}\n`);
    expect(migrate().action).toBe("staged");
  });
  test("preserves the operator redirect and inode", () => {
    const text = `${REDIRECT}='https://kept.example/oauth' # operator\n`;
    writeFileSync(envPath(), text);
    const inode = statSync(envPath()).ino;
    expect(migrate().action).toBe("already-set");
    expect(readFileSync(envPath(), "utf8")).toBe(text);
    expect(statSync(envPath()).ino).toBe(inode);
  });
  test("replaces the inode when staging", () => {
    writeFileSync(envPath(), "# retained\n", { mode: 0o640 });
    const inode = statSync(envPath()).ino;
    expect(migrate().action).toBe("staged");
    expect(statSync(envPath()).ino).not.toBe(inode);
    expect(statSync(envPath()).mode & 0o777).toBe(0o640);
  });
  test.each([`${REDIRECT}=\n${REDIRECT}=https://kept.example/oauth\n`, `${REDIRECT}=https://kept.example/oauth\nexport ${REDIRECT}='${REDIRECT}'\n`, `${REDIRECT}=https://kept.example/oauth\r${REDIRECT}=\r`])("refuses repeated redirect assignments", text => {
    writeFileSync(envPath(), text);
    expect(migrate()).toMatchObject({ action: "refused", reason: `ambiguous-env:${REDIRECT}` });
    expect(readFileSync(envPath(), "utf8")).toBe(text);
  });
  test.each(["\r", "\r\n", "\n"])("replaces a blank redirect between assignments separated by %j", separator => {
    const text = `BEFORE=retained${separator}${REDIRECT}=${separator}AFTER=retained${separator}`;
    writeFileSync(envPath(), text);
    expect(migrate().action).toBe("staged");
    const rewritten = readFileSync(envPath(), "utf8");
    expect(rewritten).toBe(`BEFORE=retained\nAFTER=retained\n${REDIRECT}=https://flair.example.com/oauth\n`);
    expect(parseMcpComponentEnv(rewritten)).toEqual({ BEFORE: "retained", AFTER: "retained", [REDIRECT]: "https://flair.example.com/oauth" });
    const require = createRequire(import.meta.url);
    const harperRequire = createRequire(require.resolve("harper"));
    const dotenv = harperRequire("dotenv") as { parse: (text: string) => Record<string, string> };
    expect(dotenv.parse(rewritten)).toEqual(parseMcpComponentEnv(rewritten));
  });
  test("refuses unreadable files", () => {
    writeFileSync(envPath(), "# keep\n");
    chmodSync(envPath(), 0);
    try { expect(migrate()).toMatchObject({ action: "refused", reason: "unreadable-env" }); }
    finally { chmodSync(envPath(), 0o600); }
    expect(readFileSync(envPath(), "utf8")).toBe("# keep\n");
  });
  test("refuses a process redirect that masks the file", () => {
    expect(migrate({ ...configured, [REDIRECT]: "" })).toMatchObject({ action: "refused", reason: "redirect-env-masks-file" });
    expect(existsSync(envPath())).toBe(false);
  });
  test.each(["=", ": "])("refuses multiline tracked assignments with %s", separator => {
    const text = `${REDIRECT}${separator}"\n\${OAUTH_GITHUB_REDIRECT_URI}\n"\n`;
    writeFileSync(envPath(), text);
    expect(migrate()).toMatchObject({ action: "refused", reason: `multiline-env:${REDIRECT}` });
    expect(readFileSync(envPath(), "utf8")).toBe(text);
  });
  test("refuses a directory at the env path", () => {
    mkdirSync(envPath());
    expect(migrate()).toMatchObject({ action: "refused", reason: "unreadable-env" });
  });
});

describe("doctor target readiness", () => {
  test("symlinked Harper guard loads retain disabled-MCP provider readiness for doctor", () => {
    const root = join(import.meta.dir, "../..");
    symlinkSync(join(root, "dist"), join(dir, "dist"));
    const drive = join(dir, "guard-loader.mjs");
    writeFileSync(drive, `
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const require = createRequire(join(root, "package.json"));
const { scopedImport } = require(join(require.resolve("harper"), "../security/jsLoader.js"));
const { describeMcpRedirectFinding } = await import(pathToFileURL(join(root, "dist/src/lib/mcp-oauth-env-core.js")));
delete process.env.FLAIR_MCP_NO_AUTOSTART;
delete process.env.OAUTH_GITHUB_REDIRECT_URI;
const scope = { mode: "vm-current-context", name: "flair" };
const readiness = [];
const findings = [];
for (const base of [process.argv[3], root]) {
  const guard = await scopedImport(pathToFileURL(join(base, "dist/resources/mcp-oauth-env-guard.js")), scope);
  const provider = guard.mcpOAuthProviderReadiness();
  readiness.push(provider);
  findings.push(describeMcpRedirectFinding(provider));
}
console.log(JSON.stringify({ readiness, findings }));
`);
    const result = spawnSync("node", ["--experimental-vm-modules", drive, root, dir], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, STORAGE_PATH: dir, ROOTPATH: dir,
        OAUTH_GITHUB_CLIENT_ID: "fixture-id", OAUTH_GITHUB_CLIENT_SECRET: "fixture-secret", FLAIR_MCP_OAUTH: "false" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    for (const finding of output.findings) {
      expect(finding?.isIssue).toBe(true);
      expect(finding?.message).toContain(REDIRECT);
    }
    expect(output.readiness).toEqual([
      { credentialsPresent: true, redirectPresent: false },
      { credentialsPresent: true, redirectPresent: false },
    ]);
  }, 15_000);
  test.each([undefined, "", "   ", "${OAUTH_GITHUB_REDIRECT_URI}"])("effective redirect %s is missing", async redirect => {
    const readiness = readMcpProviderReadiness({ ...configured, FLAIR_MCP_OAUTH: "false", [REDIRECT]: redirect });
    expect(readiness).toEqual({ credentialsPresent: true, redirectPresent: false });
    const finding = await readTargetMcpRedirectFinding(async () => ({ mcpOAuthProvider: readiness }));
    expect(finding?.isIssue).toBe(true);
    expect(finding?.message).toContain(REDIRECT);
  });
  test("service-only credentials produce a finding", async () => {
    const finding = await readTargetMcpRedirectFinding(async () => ({ mcpOAuthProvider: { credentialsPresent: true, redirectPresent: false } }));
    expect(finding?.isIssue).toBe(true);
    expect(finding?.fixHint).toContain("flair mcp enable");
  });
  test("unavailable or malformed target state cannot be verified", async () => {
    for (const read of [async () => { throw new Error("offline"); }, async () => ({}), async () => ({ mcpOAuthProvider: { credentialsPresent: "true", redirectPresent: false } })]) {
      const finding = await readTargetMcpRedirectFinding(read);
      expect(finding?.isIssue).toBe(false);
      expect(finding?.message).toContain("cannot verify");
    }
  });
  test("a resolved redirect or absent credentials needs no remedy", () => {
    expect(describeMcpRedirectFinding({ credentialsPresent: true, redirectPresent: true })).toBeNull();
    expect(describeMcpRedirectFinding({ credentialsPresent: false, redirectPresent: false })).toBeNull();
  });
});
