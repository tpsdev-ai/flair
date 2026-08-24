// component-env.test.ts — the `.env` a deploy ships to a Flair component
// (flair#1005 item 2, flair#1000, flair#1011).
//
// These are the decisions the deploy makes BEFORE any file or tarball exists:
// what value to advertise, whether to touch an operator's file at all, and what
// must never be generated into a payload that Harper persists and replicates.
// deploy-staging.test.ts covers the file/tarball half — the two halves are split
// because "a file was written" was never evidence that anything reads it.

import { describe, test, expect } from "bun:test";
import {
  COMPONENT_ENV_FILENAME,
  NEVER_GENERATED_SECRET_KEYS,
  PUBLIC_URL_KEY,
  assertNoSecretKeysAdded,
  describePublicUrlFinding,
  DURABLE_PUBLIC_URL_LOCATION,
  envKeyNames,
  isLoopbackUrl,
  isNodeModulesEnvPath,
  looksLikeSecretKey,
  planComponentEnv,
  publicUrlRemedy,
  readEnvValue,
} from "../../src/component-env.js";

describe("isLoopbackUrl", () => {
  test("recognises the addresses only the serving machine can reach", () => {
    for (const url of [
      "http://127.0.0.1:9926",
      "http://127.0.0.1:9980/OAuthAuthorize",
      "http://127.1.2.3:80",
      "http://localhost:19926",
      "https://localhost",
      "http://sub.localhost:3000",
      "http://[::1]:9926",
    ]) {
      expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: true });
    }
  });

  test("does not treat a public host as loopback", () => {
    for (const url of [
      "https://flair.example.com",
      "https://cluster.org.harperfabric.com",
      "http://10.0.0.4:9926",
      "https://192.168.1.10",
    ]) {
      expect({ url, loopback: isLoopbackUrl(url) }).toEqual({ url, loopback: false });
    }
  });

  test("a DNS name that merely STARTS with 127. is not loopback", () => {
    // The regression guard for the obvious implementation. `startsWith("127.")`
    // would classify these as loopback and silently refuse to advertise a
    // perfectly reachable host — and it is exactly the host shape used to prove
    // this feature end to end against a locally spawned Harper.
    expect(isLoopbackUrl("http://127.0.0.1.nip.io:9926")).toBe(false);
    expect(isLoopbackUrl("https://127.0.0.1.example.com")).toBe(false);
  });

  test("a non-URL is not loopback (and must not throw)", () => {
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl(null)).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("env parsing", () => {
  test("reports key names in file order, ignoring comments and blanks", () => {
    const text = "# comment\nFOO=1\n\n  BAR = 2\nexport BAZ=3\nnot an assignment\n";
    expect(envKeyNames(text)).toEqual(["FOO", "BAR", "BAZ"]);
  });

  test("reads a value, including the export and quoted forms", () => {
    expect(readEnvValue("FLAIR_PUBLIC_URL=https://a.example\n", PUBLIC_URL_KEY)).toBe("https://a.example");
    expect(readEnvValue('export FLAIR_PUBLIC_URL="https://b.example"\n', PUBLIC_URL_KEY)).toBe("https://b.example");
    expect(readEnvValue("OTHER=x\n", PUBLIC_URL_KEY)).toBeNull();
    expect(readEnvValue(null, PUBLIC_URL_KEY)).toBeNull();
  });

  test("looksLikeSecretKey flags credential-shaped NAMES", () => {
    expect(looksLikeSecretKey("HDB_ADMIN_PASSWORD")).toBe(true);
    expect(looksLikeSecretKey("FABRIC_TOKEN")).toBe(true);
    expect(looksLikeSecretKey("SOME_API_KEY")).toBe(true);
    expect(looksLikeSecretKey("FLAIR_PUBLIC_URL")).toBe(false);
    expect(looksLikeSecretKey("HTTP_PORT")).toBe(false);
  });
});

describe("planComponentEnv", () => {
  test("adds FLAIR_PUBLIC_URL when the payload has no .env at all", () => {
    const plan = planComponentEnv(null, "https://flair.example.com");
    expect(plan.action).toBe("added");
    expect(plan.effectiveValue).toBe("https://flair.example.com");
    expect(plan.text).toBe("FLAIR_PUBLIC_URL=https://flair.example.com\n");
  });

  test("appends to an operator's file without disturbing what is already there", () => {
    const existing = "# my settings\nFLAIR_MCP_OAUTH=1\nHTTP_PORT=9926\n";
    const plan = planComponentEnv(existing, "https://flair.example.com");
    expect(plan.action).toBe("added");
    expect(plan.text!.startsWith(existing)).toBe(true);
    expect(envKeyNames(plan.text)).toEqual(["FLAIR_MCP_OAUTH", "HTTP_PORT", PUBLIC_URL_KEY]);
  });

  test("does not weld two assignments together when the file has no trailing newline", () => {
    const plan = planComponentEnv("FLAIR_MCP_OAUTH=1", "https://flair.example.com");
    expect(plan.text).toBe("FLAIR_MCP_OAUTH=1\nFLAIR_PUBLIC_URL=https://flair.example.com\n");
  });

  test("NEVER overwrites a value the operator set — that is the no-clobber rule", () => {
    const existing = "FLAIR_PUBLIC_URL=https://cdn.example.com\n";
    const plan = planComponentEnv(existing, "https://cluster.org.harperfabric.com");
    expect(plan.action).toBe("operator-value-kept");
    expect(plan.text).toBeNull(); // nothing is written, so nothing is staged
    expect(plan.effectiveValue).toBe("https://cdn.example.com");
    expect(plan.notices.join(" ")).toContain("https://cdn.example.com");
    expect(plan.notices.join(" ")).toContain("keeping it");
  });

  test("an operator's `export`-prefixed assignment counts as set", () => {
    // Otherwise the merge appends a SECOND assignment for the same key, and which
    // one wins is left to the env loader — a clobber by another route.
    const plan = planComponentEnv("export FLAIR_PUBLIC_URL=https://cdn.example.com\n", "https://x.example");
    expect(plan.action).toBe("operator-value-kept");
  });

  test("says so out loud when the operator's own value is a loopback address", () => {
    const plan = planComponentEnv("FLAIR_PUBLIC_URL=http://127.0.0.1:9926\n", "https://flair.example.com");
    expect(plan.action).toBe("operator-value-kept");
    expect(plan.notices.join(" ")).toContain("loopback");
  });

  test("supplies nothing when there is no public URL to advertise", () => {
    const plan = planComponentEnv(null, null);
    expect(plan.action).toBe("unchanged");
    expect(plan.text).toBeNull();
    expect(plan.effectiveValue).toBeNull();
  });

  test("names the credential-shaped KEYS an operator's file will carry into the payload", () => {
    const plan = planComponentEnv("HDB_ADMIN_PASSWORD=whatever\n", "https://flair.example.com");
    const notice = plan.notices.join(" ");
    expect(notice).toContain("HDB_ADMIN_PASSWORD");
    expect(notice).toContain("replicated");
    // The NAME is reported; the value is not read, compared, or echoed.
    expect(notice).not.toContain("whatever");
  });

  test("generates FLAIR_PUBLIC_URL and nothing else", () => {
    const plan = planComponentEnv(null, "https://flair.example.com");
    expect(envKeyNames(plan.text)).toEqual([PUBLIC_URL_KEY]);
    for (const key of NEVER_GENERATED_SECRET_KEYS) {
      expect(plan.text).not.toContain(key);
    }
  });
});

describe("assertNoSecretKeysAdded", () => {
  test("accepts the file flair actually generates", () => {
    expect(() => assertNoSecretKeysAdded(null, "FLAIR_PUBLIC_URL=https://a.example\n")).not.toThrow();
  });

  test("throws when a generator introduces a credential (flair#1011)", () => {
    // The positive control for the test above: the guard is capable of failing.
    expect(() =>
      assertNoSecretKeysAdded(null, "FLAIR_PUBLIC_URL=https://a.example\nHDB_ADMIN_PASSWORD=x\n"),
    ).toThrow(/HDB_ADMIN_PASSWORD/);
    expect(() => assertNoSecretKeysAdded(null, "FLAIR_ADMIN_PASSWORD=x\n")).toThrow(/FLAIR_ADMIN_PASSWORD/);
  });

  test("does not punish an operator for their OWN pre-existing key", () => {
    // A `.env` in the deploy root already ships today. Refusing to deploy one
    // that was working would be a regression; the notice covers it instead.
    const existing = "HDB_ADMIN_PASSWORD=x\n";
    expect(() =>
      assertNoSecretKeysAdded(existing, `${existing}FLAIR_PUBLIC_URL=https://a.example\n`),
    ).not.toThrow();
  });
});

describe("isNodeModulesEnvPath", () => {
  test("recognises a path inside an npm package tree (posix and win32)", () => {
    expect(isNodeModulesEnvPath("/lib/node_modules/@tpsdev-ai/flair/.env")).toBe(true);
    expect(isNodeModulesEnvPath("/usr/lib/node_modules/@tpsdev-ai/flair/.env")).toBe(true);
    expect(isNodeModulesEnvPath("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@tpsdev-ai\\flair\\.env")).toBe(true);
  });

  test("does not treat a durable component or deploy-root path as node_modules", () => {
    expect(isNodeModulesEnvPath("/opt/flair/.env")).toBe(false);
    expect(isNodeModulesEnvPath(".env in the deploy root")).toBe(false);
    expect(isNodeModulesEnvPath("/home/harperdb/hdb/components/flair/.env")).toBe(false);
  });
});

describe("publicUrlRemedy", () => {
  test("names the file, the key and the loadEnv requirement", () => {
    const remedy = publicUrlRemedy("/opt/flair/.env");
    expect(remedy).toContain("/opt/flair/.env");
    expect(remedy).toContain(PUBLIC_URL_KEY);
    expect(remedy).toContain("loadEnv");
    expect(remedy).toContain(COMPONENT_ENV_FILENAME);
    expect(remedy).not.toContain("node_modules");
  });

  test("never names a .env inside node_modules — that path is wiped on upgrade (flair#1313)", () => {
    const npmPath = "/lib/node_modules/@tpsdev-ai/flair/.env";
    const remedy = publicUrlRemedy(npmPath);
    expect(remedy).not.toContain(npmPath);
    expect(remedy).not.toContain("/lib/node_modules");
    expect(remedy).toContain(PUBLIC_URL_KEY);
    expect(remedy).toContain(DURABLE_PUBLIC_URL_LOCATION);
    expect(remedy).toContain("loadEnv");
    expect(remedy).toMatch(/launchd|systemd|process environment/);
  });
});

describe("describePublicUrlFinding (flair doctor)", () => {
  const ENV_PATH = "/opt/flair/.env";
  const base = { componentEnvValue: null, processEnvValue: null, componentEnvPath: ENV_PATH };

  test("says nothing when the instance could not be asked — a skipped check is not a pass", () => {
    expect(describePublicUrlFinding({ ...base, advertisedIssuer: null })).toBeNull();
  });

  test("clean when discovery already advertises a reachable issuer", () => {
    const f = describePublicUrlFinding({ ...base, advertisedIssuer: "https://flair.example.com" })!;
    expect(f.isIssue).toBe(false);
    expect(f.icon).toBe("ok");
    expect(f.message).toContain("https://flair.example.com");
  });

  test("ISSUE: the component .env sets the key and the instance still advertises loopback", () => {
    // This is flair#1000's exact shape — the file was placed, the issuer never
    // moved, because no loadEnv declaration existed to read it.
    const f = describePublicUrlFinding({
      ...base,
      advertisedIssuer: "http://127.0.0.1:9980",
      componentEnvValue: "https://flair.example.com",
    })!;
    expect(f.isIssue).toBe(true);
    expect(f.icon).toBe("error");
    expect(f.message).toContain(ENV_PATH);
    expect(f.fixHint).toContain("loadEnv");
  });

  test("ISSUE: the value is in the operator's shell, not where the server reads it", () => {
    const f = describePublicUrlFinding({
      ...base,
      advertisedIssuer: "http://127.0.0.1:9980",
      processEnvValue: "https://flair.example.com",
    })!;
    expect(f.isIssue).toBe(true);
    expect(f.fixHint).toContain(ENV_PATH);
    expect(f.fixHint).toContain("https://flair.example.com");
  });

  test("ISSUE: a .env inside node_modules is not named as the fix (flair#1313)", () => {
    const npmPath = "/lib/node_modules/@tpsdev-ai/flair/.env";
    const f = describePublicUrlFinding({
      advertisedIssuer: "http://127.0.0.1:19926",
      componentEnvValue: null,
      processEnvValue: null,
      componentEnvPath: npmPath,
    })!;
    expect(f.fixHint).toBeDefined();
    expect(f.fixHint).not.toContain(npmPath);
    expect(f.fixHint).not.toContain("/lib/node_modules");
    expect(f.fixHint).toContain(PUBLIC_URL_KEY);
    expect(f.fixHint).toContain("loadEnv");
    expect(f.message).not.toContain("node_modules/@tpsdev-ai");
  });

  test("ISSUE: a value in this shell must not send the operator into node_modules", () => {
    // The canary shape: doctor sees FLAIR_PUBLIC_URL in the CLI process and
    // used to name /lib/node_modules/@tpsdev-ai/flair/.env as the fix.
    const npmPath = "/lib/node_modules/@tpsdev-ai/flair/.env";
    const f = describePublicUrlFinding({
      advertisedIssuer: "http://127.0.0.1:9980",
      componentEnvValue: null,
      processEnvValue: "https://flair.example.com",
      componentEnvPath: npmPath,
    })!;
    expect(f.isIssue).toBe(true);
    expect(f.fixHint).not.toContain(npmPath);
    expect(f.fixHint).not.toContain("/lib/node_modules");
    expect(f.fixHint).toContain("https://flair.example.com");
    expect(f.fixHint).toContain(DURABLE_PUBLIC_URL_LOCATION);
  });

  test("ISSUE: a value sitting in the npm-package .env is drift, and the remedy is durable", () => {
    const npmPath = "/usr/lib/node_modules/@tpsdev-ai/flair/.env";
    const f = describePublicUrlFinding({
      advertisedIssuer: "http://127.0.0.1:9980",
      componentEnvValue: "https://flair.example.com",
      processEnvValue: null,
      componentEnvPath: npmPath,
    })!;
    expect(f.isIssue).toBe(true);
    expect(f.icon).toBe("error");
    expect(f.message).not.toContain(npmPath);
    expect(f.fixHint).not.toContain(npmPath);
    expect(f.fixHint).toContain("https://flair.example.com");
    expect(f.fixHint).toContain(DURABLE_PUBLIC_URL_LOCATION);
  });

  test("unset everywhere is INFORMATION, not a finding — a check that always fires is noise", () => {
    const f = describePublicUrlFinding({ ...base, advertisedIssuer: "http://127.0.0.1:19926" })!;
    expect(f.isIssue).toBe(false);
    expect(f.icon).toBe("warn");
    expect(f.fixHint).toContain(PUBLIC_URL_KEY);
    expect(f.fixHint).toContain("loadEnv");
  });

  test("a loopback value in the component .env is not mistaken for a working one", () => {
    const f = describePublicUrlFinding({
      ...base,
      advertisedIssuer: "http://127.0.0.1:19926",
      componentEnvValue: "http://127.0.0.1:19926",
    })!;
    expect(f.isIssue).toBe(false);
    expect(f.icon).toBe("warn");
  });
});
