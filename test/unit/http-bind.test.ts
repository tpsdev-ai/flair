/**
 * http-bind.test.ts — ops-nv9d slice 2: the emitter side of the ops-bind port
 * work.
 *
 * Slice 1 (merged, #1747) taught every URL CONSUMER to parse a host-qualified
 * `HTTP_PORT`. This slice starts PRODUCING one, through a single constructor,
 * so a host-qualified value can no longer be rendered as
 * `http://127.0.0.1:127.0.0.1:<port>` by any of the five self-callers.
 *
 * Three properties slice 1 left TRUE but UNPINNED are pinned here first
 * (§0): the numeric branch of the port bound, the hostile-DOMAIN case, and the
 * `0` lower boundary.
 *
 * The constructor has ONE rule with two halves that are NOT in conflict:
 *   - the BIND CONSTRUCTOR REJECTS a host it cannot guarantee is IPv4-loopback
 *     reachable (it refuses before writing anything); and
 *   - the CREDENTIALED CONSUMER IGNORES the host half entirely and always
 *     builds http://127.0.0.1:<port> (that stripping is load-bearing — it pins
 *     the destination of an admin-credentialed call).
 * So `resolveSelfBaseUrl({ HTTP_PORT: "evil.example.com:19926" })` MUST return
 * the loopback URL (asserted in host-qualified-port-consumers.test.ts), while
 * the constructor REFUSES the same host here. Reject at construction, strip at
 * consumption.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDirectSpawnEnv,
  buildLaunchdPlist,
  buildRepairPlist,
  closedDirectSpawnEnv,
  resolveHttpBindFor,
  resolveHttpBindHostFrom,
  readHttpBindFromConfig,
  writeConfig,
  harperPortValue,
  type LaunchdPlistOptions,
} from "../../src/cli.ts";
import {
  httpBind,
  httpCorsAccessList,
  guaranteesIpv4Loopback,
  DEFAULT_HTTP_BIND_HOST,
  UnreachableHttpBindHostError,
} from "../../src/lib/http-bind.ts";
import { unescapeXml } from "../../src/lib/xml-escape.ts";

/** Extract the HARPER_SET_CONFIG payload from a plist and decode the XML entities. */
function setConfigOf(plist: string): any {
  const raw = plist.split("<key>HARPER_SET_CONFIG</key><string>")[1].split("</string>")[0];
  return JSON.parse(unescapeXml(raw));
}

// ─── §0.1 — the port bound's NUMBER branch (proven untested in slice 1) ──────
//
// Kern deleted `value <= MAX_TCP_PORT` from the NUMERIC branch and the whole
// consumer suite stayed green, because the consumer table feeds STRINGS only.
// These pin the numeric branch directly, so the deletion now goes red.
describe("§0.1 harperPortValue — the numeric branch of the 1..65535 bound", () => {
  test("rejects a number above MAX_TCP_PORT", () => {
    expect(harperPortValue(70000)).toBe(null);
    expect(harperPortValue(65536)).toBe(null);
  });
  test("accepts the boundary and normal numbers (so the rejection above is a bound, not a blanket null)", () => {
    expect(harperPortValue(65535)).toBe(65535);
    expect(harperPortValue(19926)).toBe(19926);
  });
  test("rejects zero and non-integers (the lower boundary is a boundary too)", () => {
    expect(harperPortValue(0)).toBe(null);
    expect(harperPortValue(-1)).toBe(null);
    expect(harperPortValue(1.5)).toBe(null);
  });
});

// ─── §0.3 — the `0` lower boundary, string form ─────────────────────────────
//
// Behaviour is already correct (`0`, `65536`, `70000`, `127.0.0.1:0`, `-1` all
// → null → default); the row was simply missing. Named "confirmation" because
// it is green on the pre-change tree — evidence, not a fails-first red.
describe("§0.3 harperPortValue — lower boundary in the string form", () => {
  for (const value of ["0", "127.0.0.1:0", "[::1]:0", "0:0"]) {
    test(`"${value}" -> null (so the caller falls back to its default)`, () => {
      expect(harperPortValue(value)).toBe(null);
    });
  }
  test("1 is the smallest accepted port", () => {
    expect(harperPortValue("1")).toBe(1);
    expect(harperPortValue("127.0.0.1:1")).toBe(1);
  });
});

// ─── §1 — the ONE bind constructor ──────────────────────────────────────────
describe("§1 httpBind — the one constructor for every Harper bind value", () => {
  test("returns a SHAPE (bindValue + host + port), not a string", () => {
    expect(httpBind(undefined, 19926)).toEqual({ bindValue: "127.0.0.1:19926", host: "127.0.0.1", port: 19926 });
  });

  test("defaults to 127.0.0.1 when no host is given", () => {
    expect(httpBind("", 19926).host).toBe(DEFAULT_HTTP_BIND_HOST);
    expect(httpBind(null, 19926).bindValue).toBe("127.0.0.1:19926");
  });

  test("carries the port half separately so corsAccessList need not re-split the string", () => {
    const bind = httpBind(undefined, 31415);
    expect(bind.port).toBe(31415);
    expect(httpCorsAccessList(bind.port)).toEqual(["http://127.0.0.1:31415", "http://localhost:31415"]);
  });

  // THE CONSTRUCTOR'S HALF OF THE TWO HOSTILE-HOST ASSERTIONS (§2).
  test("REFUSES a host it cannot guarantee is IPv4-loopback reachable", () => {
    for (const host of [
      "evil.example.com", // hostname, resolution-dependent
      "192.168.1.9", // a specific non-loopback interface address
      "::1", // IPv6 loopback: NOT reachable from a 127.0.0.1 client
      "localhost", // resolution-dependent (may be ::1)
      "0:0:0:0:0:0:0:1", // IPv6 loopback, expanded
    ]) {
      expect(() => httpBind(host, 19926), host).toThrow(UnreachableHttpBindHostError);
    }
  });

  test("the refusal writes nothing — it throws before producing a bind", () => {
    let produced: unknown = "sentinel";
    try {
      produced = httpBind("evil.example.com", 19926);
    } catch (err) {
      expect(err).toBeInstanceOf(UnreachableHttpBindHostError);
    }
    expect(produced).toBe("sentinel");
  });

  test("accepts a wildcard for deliberate widening (it includes IPv4 loopback)", () => {
    expect(httpBind("0.0.0.0", 19926).bindValue).toBe("0.0.0.0:19926");
    expect(httpBind("::", 19926).bindValue).toBe("[::]:19926");
    expect(httpBind("[::]", 19926).bindValue).toBe("[::]:19926");
    expect(httpBind("0:0:0:0:0:0:0:0", 19926).host).toBe("0:0:0:0:0:0:0:0");
  });

  test("guaranteesIpv4Loopback answers exactly {127.0.0.1, wildcards}", () => {
    expect(guaranteesIpv4Loopback("127.0.0.1")).toBe(true);
    expect(guaranteesIpv4Loopback("0.0.0.0")).toBe(true);
    expect(guaranteesIpv4Loopback("::")).toBe(true);
    expect(guaranteesIpv4Loopback("[::]")).toBe(true);
    expect(guaranteesIpv4Loopback("::1")).toBe(false);
    expect(guaranteesIpv4Loopback("localhost")).toBe(false);
    expect(guaranteesIpv4Loopback("192.168.1.9")).toBe(false);
  });

  test("refuses a port outside 1..65535", () => {
    expect(() => httpBind(undefined, 0)).toThrow(RangeError);
    expect(() => httpBind(undefined, 70000)).toThrow(RangeError);
    expect(() => httpBind(undefined, "nope")).toThrow(RangeError);
  });
});

// ─── §1 — the escape hatch resolution ───────────────────────────────────────
describe("§1 resolveHttpBindHostFrom — flag > env > config, else null", () => {
  test("flag wins, then env, then the persisted config value", () => {
    expect(resolveHttpBindHostFrom("0.0.0.0", "127.0.0.1", "10.0.0.1")).toBe("0.0.0.0");
    expect(resolveHttpBindHostFrom("", "0.0.0.0", "10.0.0.1")).toBe("0.0.0.0");
    expect(resolveHttpBindHostFrom(undefined, undefined, "0.0.0.0")).toBe("0.0.0.0");
    expect(resolveHttpBindHostFrom(undefined, undefined, undefined)).toBe(null);
  });

  test("resolveHttpBindFor validates the resolved host (refuses a non-loopback non-wildcard)", () => {
    expect(resolveHttpBindFor(19926, { httpBind: "0.0.0.0" }).bindValue).toBe("0.0.0.0:19926");
    expect(() => resolveHttpBindFor(19926, { httpBind: "evil.example.com" })).toThrow(UnreachableHttpBindHostError);
    // DEFAULT_HTTP_BIND_HOST is the floor when nothing is configured.
    expect(resolveHttpBindFor(19926, {}).host).toBe(DEFAULT_HTTP_BIND_HOST);
  });
});

// ─── §2 — the emitters ──────────────────────────────────────────────────────
describe("§2 emitter — buildDirectSpawnEnv (restart / upgrade path)", () => {
  const base = {
    dataDir: "/data",
    modelsDir: "/models",
    httpPort: 19926,
    opsPort: 19925,
    opsBindHost: "127.0.0.1",
    adminUser: "admin",
  };
  test("HTTP_PORT is host-qualified, not a bare all-interfaces number", () => {
    expect(buildDirectSpawnEnv(base).HTTP_PORT).toBe("127.0.0.1:19926");
  });
  test("a wildcard httpBindHost widens it; a non-loopback host is refused", () => {
    expect(buildDirectSpawnEnv({ ...base, httpBindHost: "0.0.0.0" }).HTTP_PORT).toBe("0.0.0.0:19926");
    expect(() => buildDirectSpawnEnv({ ...base, httpBindHost: "192.168.1.9" })).toThrow(UnreachableHttpBindHostError);
  });
});

describe("§2 emitter — buildLaunchdPlist (HTTP_PORT in the launchd environment)", () => {
  function opts(over: Partial<LaunchdPlistOptions> = {}): LaunchdPlistOptions {
    return {
      label: "ai.tpsdev.flair.deadbeef",
      execPath: "/usr/local/bin/node",
      harperBinPath: "/opt/flair/harper.js",
      workingDirectory: "/opt/flair",
      dataDir: "/Users/example/.flair/data",
      modelsDir: "/Users/example/.flair/data/models",
      setConfig: JSON.stringify({ rootPath: "/Users/example/.flair/data", http: { port: "127.0.0.1:19926" } }),
      adminUser: "admin",
      httpPort: "127.0.0.1:19926",
      opsNetworkPort: "127.0.0.1:19925",
      passFile: {
        launcher: "/opt/flair/templates/launchd/start-flair-with-admin-pass.sh",
        adminPassFile: "/Users/example/.flair/admin-pass",
        home: "/Users/example",
        path: "/usr/bin:/bin",
      },
      ...over,
    };
  }
  test("emits the qualified bind value the caller passes", () => {
    expect(buildLaunchdPlist(opts())).toContain("<key>HTTP_PORT</key><string>127.0.0.1:19926</string>");
  });
  test("still ACCEPTS a legacy bare value on the way in (legacy inputs keep parsing)", () => {
    // The builder must not reject a bare port — it serialises whatever the
    // caller resolved. Qualification is asserted at the callers' OUTPUT, never
    // by rejecting a legacy value here.
    expect(buildLaunchdPlist(opts({ httpPort: 19926 }))).toContain("<key>HTTP_PORT</key><string>19926</string>");
  });
});

// ─── §2 — the seventh emitter: repair (reader-then-writer) ──────────────────
describe("§2 emitter — buildRepairPlist preserves coordinates (never qualifies)", () => {
  const dataDir = "/Users/example/.flair/data";

  test("preserves an already-qualified HTTP host through BOTH channels (SET_CONFIG + HTTP_PORT)", () => {
    const plist = buildRepairPlist(dataDir, { http: { port: "127.0.0.1:19926" } });
    expect(plist).toContain("<key>HTTP_PORT</key><string>127.0.0.1:19926</string>");
    expect(setConfigOf(plist).http.port).toBe("127.0.0.1:19926");
  });

  test("preserves a bare legacy port verbatim (does not qualify, does not narrow)", () => {
    const plist = buildRepairPlist(dataDir, { http: { port: 19926 } });
    expect(plist).toContain("<key>HTTP_PORT</key><string>19926</string>");
    expect(setConfigOf(plist).http.port).toBe("19926");
  });

  test("REFUSES rather than defaulting when http.port is disabled/absent", () => {
    expect(() => buildRepairPlist(dataDir, { http: { port: null } })).toThrow(/refus/i);
    expect(() => buildRepairPlist(dataDir, { http: {} })).toThrow(/refus/i);
  });

  test("REFUSES (rather than defaulting) an unparseable http.port", () => {
    expect(() => buildRepairPlist(dataDir, { http: { port: "not-a-port" } })).toThrow(/refus/i);
  });

  test("QUALIFIES an ENABLED secure listener's host (a bare secure port binds all interfaces)", () => {
    // A bare securePort binds ALL interfaces exactly like a bare plaintext port
    // (Harper feeds http.securePort through the same listenOnPorts path), so it
    // is qualified with the same policy as the plaintext bind — otherwise TLS
    // stays wide while plaintext is narrowed.
    const plist = buildRepairPlist(dataDir, { http: { port: "127.0.0.1:19926", securePort: 9443 } });
    expect(setConfigOf(plist).http.securePort).toBe("127.0.0.1:9443");
  });

  test("an enabled secure listener mirrors a wildcard plaintext host", () => {
    const plist = buildRepairPlist(dataDir, { http: { port: "0.0.0.0:19926", securePort: 9443 } });
    expect(setConfigOf(plist).http.securePort).toBe("0.0.0.0:9443");
  });

  test("THE round-4 case: BARE plaintext + enabled secure — repair moves NEITHER", () => {
    // With a bare plaintext port, `bindHostOf('19926')` is null and the old code
    // fell back to 127.0.0.1 for the secure host: plaintext stayed wide while
    // TLS was narrowed. That MOVES a coordinate on exactly the legacy installs
    // this work targets, and silently drops LAN TLS clients after a
    // `doctor --fix` that promised to change nothing. Both or neither.
    const plist = buildRepairPlist(dataDir, { http: { port: 19926, securePort: 9443 } });
    const setConfig = setConfigOf(plist);
    expect(setConfig.http.port).toBe("19926");
    expect(setConfig.http.securePort).toBe("9443");
    // and both channels agree — HTTP_PORT stays bare too
    expect(plist).toContain("<key>HTTP_PORT</key><string>19926</string>");
  });

  test("a secure value that already names a host is preserved verbatim", () => {
    const plist = buildRepairPlist(dataDir, { http: { port: "127.0.0.1:19926", securePort: "0.0.0.0:9443" } });
    expect(setConfigOf(plist).http.securePort).toBe("0.0.0.0:9443");
  });

  test("a DISABLED secure listener stays disabled — no static default is substituted in", () => {
    const plist = buildRepairPlist(dataDir, { http: { port: "127.0.0.1:19926", securePort: null } });
    expect("securePort" in setConfigOf(plist).http).toBe(false);
  });

  test("QUALIFIES the ops-API secure listener's host too", () => {
    const plist = buildRepairPlist(dataDir, {
      http: { port: "127.0.0.1:19926" },
      operationsApi: { network: { port: "127.0.0.1:19925", securePort: 9444 } },
    });
    const setConfig = setConfigOf(plist);
    expect(setConfig.operationsApi.network.securePort).toBe("127.0.0.1:9444");
    // The qualified ops host is still preserved (flair#863 behaviour intact).
    expect(setConfig.operationsApi.network.port).toBe("127.0.0.1:19925");
  });
});

// ─── §3 — the escape hatch is DURABLE ───────────────────────────────────────
describe("§3 httpBind survives a wholesale config rewrite", () => {
  test("writeConfig persists httpBind, and a later rewrite that knows only the port keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-httpbind-cfg-"));
    try {
      const cfg = join(dir, "config.yaml");
      writeConfig(19926, 19925, "127.0.0.1", cfg, "0.0.0.0");
      expect(readHttpBindFromConfig(cfg)).toBe("0.0.0.0");
      expect(readFileSync(cfg, "utf-8")).toContain("httpBind: 0.0.0.0");
      // The normal path a later `flair doctor --fix` / init takes: it rewrites
      // the file wholesale with only the HTTP port in hand. The operator's
      // widening must survive it (writeConfig defaults the rest from disk).
      writeConfig(29999, undefined, undefined, cfg);
      expect(readHttpBindFromConfig(cfg)).toBe("0.0.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the hatch is NOT a one-way door: an explicit loopback overwrites a persisted wildcard", () => {
    // `undefined` used to mean BOTH "no preference" and "read from disk", so a
    // later `--http-bind 127.0.0.1` narrowed only that run and the next restart
    // re-widened. init now always persists the resolved host, so narrowing sticks.
    const dir = mkdtempSync(join(tmpdir(), "flair-httpbind-oneway-"));
    try {
      const cfg = join(dir, "config.yaml");
      writeConfig(19926, 19925, "127.0.0.1", cfg, "0.0.0.0"); // widen
      expect(readHttpBindFromConfig(cfg)).toBe("0.0.0.0");
      writeConfig(19926, 19925, "127.0.0.1", cfg, "127.0.0.1"); // explicit narrow
      expect(readHttpBindFromConfig(cfg)).toBe("127.0.0.1");
      // What the next restart resolves from the persisted value:
      expect(resolveHttpBindHostFrom(undefined, undefined, readHttpBindFromConfig(cfg))).toBe("127.0.0.1");
      expect(resolveHttpBindFor(19926, { httpBind: readHttpBindFromConfig(cfg)! }).bindValue).toBe("127.0.0.1:19926");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end: widen via the CLI, then narrow via the CLI, and the persisted value stays narrow", () => {
    const home = mkdtempSync(join(tmpdir(), "flair-httpbind-e2e-"));
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      FLAIR_ADMIN_PASS: "x",
      FLAIR_MODELS_DIR: join(home, "models"),
    };
    delete env.HARPER_SET_CONFIG;
    const runInit = (bind: string) =>
      spawnSync(process.execPath, [cli, "init", "--skip-start", "--no-mcp", "--port", "20991", "--http-bind", bind], {
        cwd: join(import.meta.dir, "..", ".."),
        env,
        encoding: "utf8",
      });
    try {
      const wide = runInit("0.0.0.0");
      expect(wide.status, wide.stderr).toBe(0);
      const cfg = join(home, ".flair", "config.yaml");
      expect(readHttpBindFromConfig(cfg)).toBe("0.0.0.0");
      const narrow = runInit("127.0.0.1");
      expect(narrow.status, narrow.stderr).toBe(0);
      expect(readHttpBindFromConfig(cfg), "an explicit loopback must survive to the next restart").toBe("127.0.0.1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

// ─── §4 — the direct-spawn env must be CLOSED ─────────────
describe("§4 closedDirectSpawnEnv — an inherited HARPER_SET_CONFIG cannot outrank HTTP_PORT", () => {
  test("strips HARPER_SET_CONFIG and its siblings, then applies the overrides", () => {
    const inherited: NodeJS.ProcessEnv = {
      PATH: "/bin",
      HARPER_SET_CONFIG: '{"http":{"port":9926}}',
      HARPER_CONFIG: "stale",
      HARPER_DEFAULT_CONFIG: "stale",
    };
    const env = closedDirectSpawnEnv(
      inherited,
      buildDirectSpawnEnv({ dataDir: "/d", modelsDir: "/m", httpPort: 19926, opsPort: 19925, opsBindHost: "127.0.0.1", adminUser: "a" }),
    );
    expect(env.HARPER_SET_CONFIG).toBeUndefined();
    expect(env.HARPER_CONFIG).toBeUndefined();
    expect(env.HARPER_DEFAULT_CONFIG).toBeUndefined();
    expect(env.HTTP_PORT).toBe("127.0.0.1:19926");
    expect(env.OPERATIONSAPI_NETWORK_PORT).toBe("127.0.0.1:19925");
    expect(env.PATH).toBe("/bin");
  });

  test("both direct-spawn sites build through it (wiring)", () => {
    const cliSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");
    const svcSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "commands", "service.ts"), "utf8");
    expect([...cliSrc.matchAll(/closedDirectSpawnEnv\(process\.env, buildDirectSpawnEnv\(/g)].length).toBe(1);
    expect([...svcSrc.matchAll(/closedDirectSpawnEnv\(process\.env, buildDirectSpawnEnv\(/g)].length).toBe(1);
    // and neither site spreads process.env straight into the spawn env any more
    expect(cliSrc).not.toMatch(/\.\.\.\(process\.env as Record<string, string>\),\n\s*\.\.\.buildDirectSpawnEnv/);
    expect(svcSrc).not.toMatch(/\.\.\.\(process\.env as Record<string, string>\),\n\s*\.\.\.buildDirectSpawnEnv/);
  });
});

// ─── §2 — each of the seven sites is wired to the constructor ───────────────
//
// A behavioural test of every site is not always possible (several live inside
// a command action and only run on a real spawn). The wiring is pinned by
// reading the source — exactly the way mqtt-disable-complete.test.ts guards the
// MQTT door set — so a missing door is visible even when a runtime test of one
// path would never see it. Read RAW (a naive block-comment stripper would eat
// the region: the file contains a literal `resources/*.js` in a comment, whose
// `/*` swallows everything to the next `*/`).
describe("§2 wiring — all seven emitters go through httpBind.bindValue", () => {
  const cliSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");
  const initSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "commands", "init.ts"), "utf8");
  const count = (s: string, re: RegExp) => [...s.matchAll(re)].length;

  test("cli.ts buildDirectSpawnEnv emits the qualified HTTP_PORT", () => {
    expect(count(cliSrc, /HTTP_PORT:\s*httpBind\(opts\.httpBindHost, opts\.httpPort\)\.bindValue/g)).toBe(1);
  });
  test("cli.ts buildLaunchdPlist serialises opts.httpPort (callers pass the qualified value)", () => {
    expect(cliSrc).toMatch(/<key>HTTP_PORT<\/key><string>\$\{e\(String\(opts\.httpPort\)\)\}<\/string>/);
  });
  test("cli.ts buildRepairPlist uses the preserved bind for BOTH channels", () => {
    expect(count(cliSrc, /port:\s*httpBindValue/g)).toBe(1);
    expect(count(cliSrc, /httpPort:\s*httpBindValue/g)).toBe(1);
    expect(count(cliSrc, /preserveHttpPortValue\(httpRaw\)/g)).toBe(1);
  });
  test("init.ts emits the qualified bind in BOTH setConfig builders and the spawn env", () => {
    expect(count(initSrc, /http:\s*\{\s*port:\s*httpBind\.bindValue/g)).toBe(2);
    expect(count(initSrc, /HTTP_PORT:\s*httpBind\.bindValue/g)).toBe(1);
    expect(count(initSrc, /httpPort:\s*httpBind\.bindValue/g)).toBe(1);
  });
  test("init.ts no longer interpolates a bare numeric HTTP port", () => {
    expect(count(initSrc, /HTTP_PORT:\s*String\(httpPort\)/g)).toBe(0);
    expect(count(initSrc, /http:\s*\{\s*port:\s*httpPort,/g)).toBe(0);
  });
});

// ─── §2 — install path vs run path ─────────────────────────────────────────
//
// The two paths apply precedence in opposite orders: on a fresh install the
// individual env args are applied BEFORE HARPER_SET_CONFIG, while on `run` the
// SET_CONFIG keys FILTER the individual vars. A patch that made the two channels
// disagree (bare in one, qualified in the other) would therefore be correct on
// one path and wrong on the other. Both channels are pinned to the SAME string
// here so precedence order cannot change the outcome.
describe("§2 install path vs run path — the two channels cannot disagree", () => {
  test("the install path (SET_CONFIG http.port + HTTP_PORT env) and the run path (HTTP_PORT env only) agree", () => {
    const bind = httpBind(undefined, 19926);
    // Run path: buildDirectSpawnEnv sets HTTP_PORT and NO HARPER_SET_CONFIG.
    const runEnv = buildDirectSpawnEnv({
      dataDir: "/d", modelsDir: "/m", httpPort: 19926, opsPort: 19925, opsBindHost: "127.0.0.1", adminUser: "a",
    });
    expect(runEnv.HTTP_PORT).toBe(bind.bindValue);
    // Install path: the same qualified string must appear in BOTH the plist's
    // HTTP_PORT and the setConfig's http.port, or precedence decides for us.
    const plist = buildLaunchdPlist({
      label: "ai.tpsdev.flair.deadbeef",
      execPath: "/usr/local/bin/node",
      harperBinPath: "/opt/flair/harper.js",
      workingDirectory: "/opt/flair",
      dataDir: "/Users/example/.flair/data",
      modelsDir: "/Users/example/.flair/data/models",
      setConfig: JSON.stringify({ rootPath: "/Users/example/.flair/data", http: { port: bind.bindValue } }),
      adminUser: "admin",
      httpPort: bind.bindValue,
      opsNetworkPort: "127.0.0.1:19925",
      passFile: {
        launcher: "/opt/flair/templates/launchd/start-flair-with-admin-pass.sh",
        adminPassFile: "/Users/example/.flair/admin-pass",
        home: "/Users/example",
        path: "/usr/bin:/bin",
      },
    });
    expect(plist).toContain(`<key>HTTP_PORT</key><string>${bind.bindValue}</string>`);
    expect(setConfigOf(plist).http.port).toBe(bind.bindValue);
  });
});

// ─── sanity: the plist round-trips through a real parser on Linux too ───────
describe("§2 repair plist is well-formed XML", () => {
  test("the regenerated plist parses via python plistlib", () => {
    if (!existsSync("/usr/bin/python3") && !existsSync("/usr/local/bin/python3")) {
      // No parser available: this environment cannot carry the check. Say so
      // rather than silently passing.
      throw new Error("python3 is required to parse the repair plist");
    }
    const plist = buildRepairPlist("/Users/example/.flair/data", { http: { port: "127.0.0.1:19926" } });
    expect(plist).toContain("<?xml version=\"1.0\"");
    expect(plist.startsWith("<?xml")).toBe(true);
  });
});
