/**
 * launchd-plist-xml-escape.test.ts — a launchd plist is XML, so every value
 * interpolated into it has to be XML-escaped.
 *
 * The plist writer used to interpolate the data directory (and the install
 * paths, the admin username/password, and the label) raw. `--data-dir` accepts
 * any legal path and `&`, `<`, `>`, `"` and `'` are all legal in one, so a data
 * dir containing `&` produced a MALFORMED plist — not a cosmetic problem:
 * `launchctl load` rejects it outright and the service never registers.
 *
 * These tests assert by actually PARSING the generated plist and reading the
 * value back. A string match for `&amp;` would pass on a plist that is still
 * malformed somewhere else, and would not catch escaping that mangles the path
 * it was supposed to preserve.
 *
 * Parsing goes through EVERY parser available on the machine — `plutil` (the
 * parser launchd's own loader uses), `xmllint`, and Python's stdlib `plistlib`
 * — and they must agree. macOS has all three; Linux CI ships neither plutil
 * nor xmllint, so plistlib is what carries the check there. If NONE is present
 * the helper throws rather than skipping: a parse check that silently degrades
 * into nothing is worse than no check, because it still reads green.
 *
 * SAFETY: buildLaunchdPlist() is a pure function — nothing here touches
 * ~/Library/LaunchAgents, runs launchctl, or reads a real plist (a real one
 * embeds HDB_ADMIN_PASSWORD). Fixtures use placeholder credentials and are
 * written to a temp dir.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildLaunchdPlist,
  assertLaunchdServiceOwnedBy,
  type LaunchdPlistOptions,
} from "../../src/cli.ts";
import { escapeXml, unescapeXml } from "../../src/lib/xml-escape.ts";
import { renderTemplate, renderPlistTemplate } from "../../src/rem/scheduler.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "flair-plist-escape-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Placeholder values only — never a real credential. */
function opts(over: Partial<LaunchdPlistOptions> = {}): LaunchdPlistOptions {
  return {
    label: "ai.tpsdev.flair.deadbeef",
    execPath: "/usr/local/bin/node",
    harperBinPath: "/opt/flair/harper.js",
    workingDirectory: "/opt/flair",
    dataDir: "/Users/example/.flair/data",
    modelsDir: "/Users/example/.flair/data/models",
    setConfig: JSON.stringify({ rootPath: "/Users/example/.flair/data", http: { port: 9926 } }),
    adminUser: "admin",
    adminPass: "PLACEHOLDER-not-a-real-password",
    httpPort: 9926,
    opsNetworkPort: "9925",
    ...over,
  };
}

function have(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe" });
    return true;
  } catch (e: any) {
    // Present but unhappy with --version (plutil) still counts as present;
    // only "not installed" (ENOENT) means we cannot use it.
    return e?.code !== "ENOENT";
  }
}
const HAS_PLUTIL = have("plutil");
const HAS_XMLLINT = have("xmllint");
const HAS_PYTHON = have("python3");

/**
 * Read a plist via Python's stdlib plistlib — a real plist parser that raises
 * on a malformed document. This is the parser that carries the check on Linux
 * CI, which ships neither plutil nor xmllint.
 */
const PY_DUMP = "import plistlib,json,sys;json.dump(plistlib.load(open(sys.argv[1],'rb')),sys.stdout)";

/**
 * Parse `plistText` with every available parser and return the value at the
 * given location, which each parser must agree on.
 *
 * `xpath` addresses it for xmllint; `fromJson` picks it out of plutil's JSON
 * conversion. Both parsers decode XML entities, so the returned value is the
 * ORIGINAL string — which is what makes these round-trip assertions real
 * rather than a string match on the escaped form.
 */
function readValue(plistText: string, xpath: string, fromJson: (o: any) => unknown): string {
  const path = join(tmp, "probe.plist");
  writeFileSync(path, plistText);

  const seen: Array<[string, string]> = [];
  if (HAS_PLUTIL) {
    // Non-zero exit (thrown) if the document is not a well-formed plist.
    execFileSync("plutil", ["-lint", path], { stdio: "pipe" });
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf-8" });
    seen.push(["plutil", String(fromJson(JSON.parse(json)))]);
  }
  if (HAS_XMLLINT) {
    // --nonet: never fetch the Apple DTD the doctype names.
    execFileSync("xmllint", ["--nonet", "--noout", path], { stdio: "pipe" });
    const out = execFileSync("xmllint", ["--nonet", "--xpath", xpath, path], { encoding: "utf-8" });
    // xmllint terminates --xpath output with a newline of its own. Strip
    // exactly one (not .trim()) so genuine leading/trailing whitespace in a
    // value would still show up as a mismatch against the other parsers.
    seen.push(["xmllint", out.replace(/\n$/, "")]);
  }
  if (HAS_PYTHON) {
    // plistlib raises on a malformed document, so this throws just like the
    // other two rather than quietly returning a partial parse.
    const json = execFileSync("python3", ["-c", PY_DUMP, path], { encoding: "utf-8", stdio: "pipe" });
    seen.push(["plistlib", String(fromJson(JSON.parse(json)))]);
  }
  if (seen.length === 0) {
    throw new Error(
      "no plist/XML parser available (need plutil, xmllint or python3) — refusing to skip a parse check",
    );
  }
  for (const [name, value] of seen) {
    expect(`${name}=${value}`).toBe(`${name}=${seen[0]![1]}`);
  }
  return seen[0]![1];
}

/** A value under the top-level <dict> (Label, WorkingDirectory, StandardOutPath, ...). */
function readTop(plistText: string, key: string): string {
  return readValue(
    plistText,
    `string(/plist/dict/key[.='${key}']/following-sibling::string[1])`,
    (o) => o[key],
  );
}

/** A value under the EnvironmentVariables sub-dict. */
function readEnvVar(plistText: string, key: string): string {
  return readValue(
    plistText,
    `string(/plist/dict/key[.='EnvironmentVariables']/following-sibling::dict[1]/key[.='${key}']/following-sibling::string[1])`,
    (o) => o.EnvironmentVariables[key],
  );
}

/** The nth <string> of the ProgramArguments array (0-based). */
function readProgramArg(plistText: string, index: number): string {
  return readValue(
    plistText,
    `string(/plist/dict/key[.='ProgramArguments']/following-sibling::array[1]/string[${index + 1}])`,
    (o) => o.ProgramArguments[index],
  );
}

describe("escapeXml", () => {
  test("escapes all five XML predefined entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("escapes & FIRST so the other entities are not double-escaped", () => {
    // If `<` were replaced before `&`, this would come out as `&amp;lt;`.
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  test("leaves a string with no special characters untouched", () => {
    expect(escapeXml("/Users/example/.flair/data")).toBe("/Users/example/.flair/data");
  });

  test("round-trips through unescapeXml, including a literal entity reference", () => {
    for (const s of [`&<>"'`, "/tmp/a&b", "&amp;", "&lt;script&gt;", "plain"]) {
      expect(unescapeXml(escapeXml(s))).toBe(s);
    }
  });
});

describe("buildLaunchdPlist — data dir containing XML metacharacters", () => {
  test("a data dir containing & produces a plist that PARSES", () => {
    const dataDir = "/Users/example/R&D/.flair/data";
    // Reading it back proves both that it parsed and that it survived intact.
    expect(readEnvVar(buildLaunchdPlist(opts({ dataDir })), "ROOTPATH")).toBe(dataDir);
  });

  for (const [name, dataDir] of [
    ["ampersand", "/Users/example/R&D/data"],
    ["less-than", "/Users/example/a<b/data"],
    ["greater-than", "/Users/example/a>b/data"],
    ["double quote", '/Users/example/a"b/data'],
    ["single quote", "/Users/example/o'brien/data"],
    ["all five at once", `/Users/example/a&b<c>d"e'f/data`],
  ] as const) {
    test(`round-trip: a data dir containing ${name} reads back identical`, () => {
      const plist = buildLaunchdPlist(opts({ dataDir }));
      expect(readEnvVar(plist, "ROOTPATH")).toBe(dataDir);
    });
  }

  test("the log paths derived from the data dir are escaped too", () => {
    const dataDir = "/Users/example/R&D/data";
    const plist = buildLaunchdPlist(opts({ dataDir }));
    expect(readTop(plist, "StandardOutPath")).toBe(join(dataDir, "log", "launchd-stdout.log"));
    expect(readTop(plist, "StandardErrorPath")).toBe(join(dataDir, "log", "launchd-stderr.log"));
  });
});

describe("buildLaunchdPlist — every other interpolated value", () => {
  // Each of these reaches the XML as a <string>; none may break the document.
  const hostile = `a&b<c>d"e'f`;

  test("modelsDir round-trips", () => {
    const modelsDir = `/opt/${hostile}/models`;
    expect(readEnvVar(buildLaunchdPlist(opts({ modelsDir })), "FLAIR_MODELS_DIR")).toBe(modelsDir);
  });

  test("adminUser round-trips", () => {
    expect(readEnvVar(buildLaunchdPlist(opts({ adminUser: hostile })), "HDB_ADMIN_USERNAME")).toBe(hostile);
  });

  test("a placeholder admin password containing metacharacters round-trips", () => {
    // --admin-pass / an admin-pass file accepts arbitrary bytes, so this value
    // is as capable of breaking the XML as any path. Placeholder only.
    const placeholder = `PLACEHOLDER-${hostile}`;
    expect(readEnvVar(buildLaunchdPlist(opts({ adminPass: placeholder })), "HDB_ADMIN_PASSWORD")).toBe(placeholder);
  });

  test("the HARPER_SET_CONFIG JSON payload round-trips as exact JSON", () => {
    const setConfig = JSON.stringify({ rootPath: `/Users/example/R&D/data`, http: { port: 9926, cors: true } });
    const got = readEnvVar(buildLaunchdPlist(opts({ setConfig })), "HARPER_SET_CONFIG");
    expect(got).toBe(setConfig);
    expect(JSON.parse(got).rootPath).toBe("/Users/example/R&D/data");
  });

  test("install paths (execPath, harperBinPath, workingDirectory) round-trip", () => {
    const plist = buildLaunchdPlist(opts({
      execPath: `/usr/${hostile}/node`,
      harperBinPath: `/opt/${hostile}/harper.js`,
      workingDirectory: `/opt/${hostile}`,
    }));
    expect(readProgramArg(plist, 0)).toBe(`/usr/${hostile}/node`);
    expect(readProgramArg(plist, 1)).toBe(`/opt/${hostile}/harper.js`);
    expect(readTop(plist, "WorkingDirectory")).toBe(`/opt/${hostile}`);
  });

  test("the label round-trips", () => {
    const plist = buildLaunchdPlist(opts({ label: `ai.tpsdev.flair.${hostile}` }));
    expect(readTop(plist, "Label")).toBe(`ai.tpsdev.flair.${hostile}`);
  });

  test("a plist with no special characters anywhere still parses", () => {
    expect(readEnvVar(buildLaunchdPlist(opts()), "ROOTPATH")).toBe("/Users/example/.flair/data");
  });
});

/**
 * The ownership guard greps ROOTPATH back out of the plist with a regex rather
 * than a real parser, so it is coupled to the writer's escaping: before the
 * writer escaped, the grep round-tripped by accident. If the reader did not
 * unescape, a data dir containing `&` would read back as `...&amp;...`, never
 * equal itself, and the guard would refuse a perfectly legitimate stop/start.
 */
describe("assertLaunchdServiceOwnedBy — round-trips the writer's escaping", () => {
  function writePlist(dataDir: string): string {
    const path = join(tmp, "owned.plist");
    writeFileSync(path, buildLaunchdPlist(opts({ dataDir })));
    return path;
  }

  for (const [name, dataDir] of [
    ["ampersand", "/Users/example/R&D/data"],
    ["all five metacharacters", `/Users/example/a&b<c>d"e'f/data`],
    ["no special characters", "/Users/example/.flair/data"],
  ] as const) {
    test(`does NOT refuse its own instance when the path contains ${name}`, () => {
      const path = writePlist(dataDir);
      expect(() => assertLaunchdServiceOwnedBy(dataDir, "ai.tpsdev.flair.deadbeef", path, "stop")).not.toThrow();
    });
  }

  test("still refuses a plist registered to a DIFFERENT data dir", () => {
    const path = writePlist("/Users/example/R&D/data");
    expect(() => assertLaunchdServiceOwnedBy("/Users/example/other/data", "ai.tpsdev.flair.deadbeef", path, "stop"))
      .toThrow(/different Flair instance/);
  });

  test("the refusal message reports the DECODED path, not the escaped one", () => {
    const path = writePlist("/Users/example/R&D/data");
    expect(() => assertLaunchdServiceOwnedBy("/Users/example/other/data", "ai.tpsdev.flair.deadbeef", path, "stop"))
      .toThrow(/R&D/);
  });
});

/**
 * The second plist writer: `flair rem nightly enable` renders
 * templates/launchd/dev.flair.rem.nightly.plist.tmpl. FLAIR_URL is the
 * realistic carrier here — a URL with two query parameters contains `&` — but
 * HOME and SHIM_PATH are arbitrary paths and equally capable of it.
 *
 * The same substitutions are ALSO rendered into the systemd units and the
 * shell shim, where XML escaping would be corruption, so only the plist
 * render escapes. Both halves of that are pinned below.
 */
describe("renderPlistTemplate — the rem nightly scheduler plist", () => {
  const PLIST_TMPL = join(import.meta.dir, "../../templates/launchd/dev.flair.rem.nightly.plist.tmpl");

  function subs(over: Record<string, string> = {}) {
    return {
      FLAIR_BIN: "/usr/local/bin/flair",
      SHIM_PATH: "/Users/example/.flair/bin/flair-rem-nightly",
      HOME: "/Users/example",
      AGENT_ID: "test-agent",
      FLAIR_URL: "http://127.0.0.1:9926",
      HOUR: "3",
      HOUR_PAD: "03",
      MINUTE: "0",
      MINUTE_PAD: "00",
      ...over,
    } as any;
  }

  function render(over: Record<string, string> = {}): string {
    return renderPlistTemplate(readFileSync(PLIST_TMPL, "utf-8"), subs(over));
  }

  test("a FLAIR_URL with two query parameters produces a plist that PARSES", () => {
    const url = "http://127.0.0.1:9926/?a=1&b=2";
    expect(readEnvVar(render({ FLAIR_URL: url }), "FLAIR_URL")).toBe(url);
  });

  test("HOME containing XML metacharacters round-trips into every place it lands", () => {
    const home = `/Users/a&b<c>d"e'f`;
    const plist = render({ HOME: home });
    expect(readEnvVar(plist, "HOME")).toBe(home);
    expect(readTop(plist, "WorkingDirectory")).toBe(home);
    expect(readTop(plist, "StandardOutPath")).toBe(`${home}/.flair/logs/rem-nightly.stdout.log`);
    expect(readTop(plist, "StandardErrorPath")).toBe(`${home}/.flair/logs/rem-nightly.stderr.log`);
  });

  test("SHIM_PATH containing & round-trips as the program argument", () => {
    const shim = "/Users/example/R&D/.flair/bin/flair-rem-nightly";
    expect(readProgramArg(render({ SHIM_PATH: shim }), 0)).toBe(shim);
  });

  test("an ordinary render is unchanged and still parses", () => {
    const plist = render();
    expect(readTop(plist, "Label")).toBe("dev.flair.rem.nightly");
    expect(readEnvVar(plist, "FLAIR_AGENT_ID")).toBe("test-agent");
    expect(
      readValue(
        plist,
        "string(/plist/dict/key[.='StartCalendarInterval']/following-sibling::dict[1]/key[.='Hour']/following-sibling::integer[1])",
        (o) => o.StartCalendarInterval.Hour,
      ),
    ).toBe("3");
  });

  test("renderTemplate (systemd/shim) does NOT XML-escape — that would be corruption", () => {
    // The shell shim and systemd units are not XML. An & there must stay an &.
    const out = renderTemplate("FLAIR_URL={{FLAIR_URL}}", subs({ FLAIR_URL: "http://h/?a=1&b=2" }));
    expect(out).toBe("FLAIR_URL=http://h/?a=1&b=2");
  });

  test("renderPlistTemplate still rejects an unknown placeholder", () => {
    expect(() => renderPlistTemplate("{{NOPE}}", subs())).toThrow(/unknown template placeholder/);
  });
});
