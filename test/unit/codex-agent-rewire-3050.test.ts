import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recognizeCodexFlairSection,
  codexFlairSectionSpan,
  codexReplacementPreservesBoundary,
  replaceCodexFlairBlock,
  codexFlairSectionText,
  tomlSnippet,
  wireCodex,
} from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

/**
 * flair#3050 — `flair init --agent <b>` must rewire Codex too.
 *
 * `_wireCodex` used to treat a `[mcp_servers.flair]` section carrying the
 * current pin as "already wired" without looking at its env, while the JSON
 * path no-ops only when the pin AND FLAIR_AGENT_ID AND FLAIR_URL all match.
 * A second init with a different agent therefore left Codex on the first one.
 *
 */
const URL_A = "http://127.0.0.1:19926";
const ENV_A = { FLAIR_AGENT_ID: "agent-a", FLAIR_URL: URL_A };
const ENV_B = { FLAIR_AGENT_ID: "agent-b", FLAIR_URL: URL_A };

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-3050-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function cfgPath(): string {
  return join(isoHome, ".codex", "config.toml");
}

function seed(section: string): string {
  mkdirSync(join(isoHome, ".codex"), { recursive: true });
  writeFileSync(cfgPath(), section);
  return section;
}

function section(spec: string, agent: string, url: string): string {
  return [
    "[other_server]",
    'command = "echo"',
    "",
    "[mcp_servers.flair]",
    'command = "npx"',
    `args = ["-y", "${spec}"]`,
    "",
    "[mcp_servers.flair.env]",
    `FLAIR_AGENT_ID = "${agent}"`,
    `FLAIR_URL = "${url}"`,
    "",
  ].join("\n");
}

/** A refusal is ok:false, names the file and the hand-edit remedy, and writes
 *  nothing — no bytes change and no `.bak` appears. */
function expectRefusal(raw: string, res: { ok: boolean; message: string }): void {
  expect(recognizeCodexFlairSection(raw).kind).toBe("refused");
  expect(res.ok).toBe(false);
  expect(res.message).toContain("~/.codex/config.toml");
  expect(res.message).toContain("not the shape Flair writes");
  expect(res.message).toContain("edit the [mcp_servers.flair] section by hand, or remove it and re-run flair init");
  expect(readFileSync(cfgPath(), "utf-8")).toBe(raw);
  expect(existsSync(`${cfgPath()}.bak`)).toBe(false);
  expect(readdirSync(join(isoHome, ".codex")).sort().join(",")).toBe("config.toml");
  expect(codexFlairSectionText(raw)).toBeNull();
  expect(codexFlairSectionSpan(raw)).toBeNull();
  expect(replaceCodexFlairBlock(raw, ENV_B).ok).toBe(false);
}

describe("flair#3050 — Codex env is part of the already-wired check", () => {
  it("current pin + agent-a, called with agent-b → rewrites the env and reports wired", () => {
    seed(section(mcpServerSpec(), "agent-a", URL_A));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
    expect(toml).not.toContain('FLAIR_AGENT_ID = "agent-a"');
    expect(toml.match(/^FLAIR_AGENT_ID/gm)?.length).toBe(1);
    // The sibling table BEFORE the Flair section survives the replace.
    expect(toml).toContain("[other_server]");
    expect(toml).toContain('command = "echo"');
  });

  it("current pin + a different FLAIR_URL → rewrites the URL and reports wired", () => {
    seed(section(mcpServerSpec(), ENV_A.FLAIR_AGENT_ID, "http://127.0.0.1:1111"));
    const res = wireCodex(ENV_A);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain(`FLAIR_URL = "${URL_A}"`);
    expect(toml).not.toContain("http://127.0.0.1:1111");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-a"');
  });

  it("current pin + the same env → already wired, bytes unchanged", () => {
    const before = seed(section(mcpServerSpec(), ENV_A.FLAIR_AGENT_ID, URL_A));
    const res = wireCodex(ENV_A);
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Codex: already wired in ~/.codex/config.toml");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });

  it("a pin the guard refuses to lower stays held even when the agent differs", () => {
    const ahead = `${FLAIR_MCP_PACKAGE}@9.9.9`;
    const before = seed(section(ahead, "agent-a", URL_A));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("AHEAD");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });

  it("an indented sibling table after the Flair section survives the replace", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      "",
      "  [mcp_servers.other]",
      '  command = "echo"',
      '  args = ["hello"]',
      "",
    ].join("\n"));
    // A real TOML parser reads the indented header as its own table.
    const before = Bun.TOML.parse(raw) as any;
    expect(before.mcp_servers.other.command).toBe("echo");

    const res = wireCodex(ENV_B);
    expect(res.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    const toml = readFileSync(cfgPath(), "utf-8");
    const after = Bun.TOML.parse(toml) as any;
    expect(after.mcp_servers.flair.env.FLAIR_AGENT_ID).toBe(ENV_B.FLAIR_AGENT_ID);
    expect(after.mcp_servers.other.command).toBe("echo");
    expect(after.mcp_servers.other.args).toEqual(["hello"]);
    expect(toml).toContain('\n  [mcp_servers.other]\n  command = "echo"\n  args = ["hello"]\n');
  });
});

describe("flair#3050 round 5 — a foreign shape is refused, never rewritten", () => {
  it("an empty FLAIR_AGENT_ID after a matching assignment is refused", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      'FLAIR_AGENT_ID = ""',
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("trailing material after a closing quote (`\"agent-a\"junk`) is refused", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "agent-a"junk`,
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    // The fixture is what it claims: a real parser rejects it.
    expect(() => Bun.TOML.parse(raw)).toThrow();
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("an unterminated env value is refused", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a',
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("conflicting duplicate agent values are refused", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-b"',
      `FLAIR_URL = "${URL_A}"`,
      'FLAIR_AGENT_ID = "agent-c"',
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_B));
  });

  it("an identical duplicate env assignment is refused: a real parser rejects the file", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      "",
    ].join("\n"));
    // The fixture is what it claims: Bun's TOML parser rejects a duplicate key.
    expect(() => Bun.TOML.parse(raw)).toThrow();
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("an inline env table is refused: Flair writes the env table form", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      `env = { FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}", FLAIR_URL = "${URL_A}" }`,
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("matching values only in [mcp_servers.flair.extra] and no env table are refused", () => {
    const raw = seed([
      "[other_server]",
      'command = "echo"',
      "",
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.extra]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_A));
  });

  it("a multiline array inside the flair section is refused", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      "args = [",
      '  "-y",',
      `  "${mcpServerSpec()}",`,
      "]",
      "",
      "[mcp_servers.flair.env]",
      `FLAIR_AGENT_ID = "${ENV_A.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n"));
    expectRefusal(raw, wireCodex(ENV_B));
  });

  it("a multiline array in ANOTHER table after the section is preserved byte-for-byte", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      "",
      "[other]",
      "data = [",
      '  ["one", "two"],',
      '  ["three", "four"],',
      "]",
      "",
    ].join("\n"));
    const suffix = raw.slice(raw.indexOf("[other]"));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
    expect(toml.endsWith(suffix)).toBe(true);
    expect((Bun.TOML.parse(toml) as any).other.data).toEqual([["one", "two"], ["three", "four"]]);
  });

  it("an indented array-of-tables sibling after the section is preserved byte-for-byte", () => {
    const raw = seed([
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      "",
      "  [[mcp_servers.other]]",
      '  name = "x"',
      "",
    ].join("\n"));
    const suffix = raw.slice(raw.indexOf("  [[mcp_servers.other]]"));
    const res = wireCodex(ENV_B);
    expect(res.ok).toBe(true);
    const toml = readFileSync(cfgPath(), "utf-8");
    expect(toml).toContain('FLAIR_AGENT_ID = "agent-b"');
    expect(toml.endsWith(suffix)).toBe(true);
    expect((Bun.TOML.parse(toml) as any).mcp_servers.other[0].name).toBe("x");
  });
});

describe("flair#3050 round 5 — one span for the read and the write path", () => {
  const fixtures: Array<[string, string]> = [
    ["canonical section at EOF", [
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      "",
    ].join("\n")],
    ["sibling table after the section", [
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      "",
      "[other]",
      'k = "v"',
      "",
    ].join("\n")],
    ["array-of-tables sibling after the section", [
      "[mcp_servers.flair]",
      'command = "npx"',
      `args = ["-y", "${mcpServerSpec()}"]`,
      "",
      "[mcp_servers.flair.env]",
      'FLAIR_AGENT_ID = "agent-a"',
      `FLAIR_URL = "${URL_A}"`,
      "",
      "  [[mcp_servers.other]]",
      '  name = "x"',
      "",
    ].join("\n")],
  ];

  for (const [label, raw] of fixtures) {
    it(`read and write agree on the span: ${label}`, () => {
      seed(raw);
      const span = codexFlairSectionSpan(raw);
      expect(span).not.toBeNull();
      expect(codexFlairSectionText(raw)).toBe(raw.slice(span!.start, span!.end));

      const replacement = replaceCodexFlairBlock(raw, ENV_B);
      expect(replacement.ok).toBe(true);
      const res = wireCodex(ENV_B);
      expect(res.ok).toBe(true);
      const expected = raw.slice(0, span!.start) + tomlSnippet(ENV_B) + "\n" + raw.slice(span!.end);
      expect(replacement).toEqual({ ok: true, text: expected });
      expect(readFileSync(cfgPath(), "utf-8")).toBe(expected);
    });
  }
});


describe("Codex shape boundaries", () => {
  for (const header of [
    " [mcp_servers.flair]", "[mcp_servers.flair] ", "[mcp_servers.flair] # edited",
    '[mcp_servers."flair"]', '["mcp_servers".flair]', "[[mcp_servers.flair]]",
    "[mcp_servers.flair.env]",
  ]) {
    it(`refuses a noncanonical header: ${header}`, () => {
      const raw = seed(tomlSnippet(ENV_A).replace("[mcp_servers.flair]", header) + "\n");
      expectRefusal(raw, wireCodex(ENV_B));
    });
  }

  for (const line of [
    'EXTRA = "value"', '# edited', 'FLAIR_URL = ""',
    '[mcp_servers."flair".extra]',
    'FLAIR_AGENT_ID = "agent-a"junk', 'FLAIR_AGENT_ID = "agent-a"',
    'data = [\n  ["one", "two"],\n]', '  ["one", "two"],',
    'FLAIR_CLIENT = "client\tname"',
  ]) {
    it(`refuses an extra env line: ${JSON.stringify(line)}`, () => {
      const raw = seed(tomlSnippet(ENV_A) + "\n" + line + "\n");
      expectRefusal(raw, wireCodex(ENV_B));
    });
  }

  for (const boundary of ["[]", "[[]]", "[ = ]", '["one", "two"]']) {
    it(`refuses an invalid table boundary: ${boundary}`, () => {
      const raw = seed(tomlSnippet(ENV_A) + "\n\n" + boundary + "\n");
      expectRefusal(raw, wireCodex(ENV_B));
    });
  }

  it("rewrites a recognized section without a final newline", () => {
    const raw = seed(tomlSnippet(ENV_A));
    const span = codexFlairSectionSpan(raw)!;
    expect(span.end).toBe(raw.length);
    expect(codexFlairSectionText(raw)).toBe(raw);
    const replacement = replaceCodexFlairBlock(raw, ENV_B);
    expect(replacement).toEqual({ ok: true, text: tomlSnippet(ENV_B) + "\n" });
    expect(wireCodex(ENV_B).ok).toBe(true);
    expect(readFileSync(cfgPath(), "utf8")).toBe(tomlSnippet(ENV_B) + "\n");
  });

  it("checks prefix and suffix identity before accepting a replacement", () => {
    const prefix = '# unicode: é\n[other]\nx = "before"\n\n';
    const suffix = '\n  [[items]]\nname = "after"\n';
    const raw = prefix + tomlSnippet(ENV_A) + "\n" + suffix;
    const span = codexFlairSectionSpan(raw)!;
    const block = tomlSnippet(ENV_B) + "\n";
    const text = raw.slice(0, span.start) + block + raw.slice(span.end);
    const intact = (candidate: string) => codexReplacementPreservesBoundary(raw, candidate, span.start, span.end, block.length);
    expect(intact(text)).toBe(true);
    expect(intact(text.replace("before", "BEFORE"))).toBe(false);
    expect(intact(text.replace("after", "AFTER"))).toBe(false);
    expect(intact(text + " ")).toBe(false);
    seed(raw);
    expect(wireCodex(ENV_B).ok).toBe(true);
    expect(readFileSync(cfgPath(), "utf8")).toBe(text);
  });

  for (const side of ["prefix", "suffix"]) {
    it(`refuses a candidate that changes its ${side} before backup or write`, () => {
      const raw = seed('# before\n' + tomlSnippet(ENV_A) + '\n\n[other]\nvalue = "after"\n');
      const result = wireCodex(ENV_B, {
        beforeBoundaryCheck: (text) => side === "prefix"
          ? text.replace("before", "BEFORE")
          : text.replace("after", "AFTER"),
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("the bytes around the [mcp_servers.flair] section changed");
      expect(readFileSync(cfgPath(), "utf8")).toBe(raw);
      expect(readdirSync(join(isoHome, ".codex"))).toEqual(["config.toml"]);
    });
  }

  for (const side of ["prefix", "suffix"]) {
    it(`refuses lossy UTF-8 in the ${side} without a backup`, () => {
      const text = tomlSnippet(ENV_A) + "\n";
      const invalid = Buffer.from([0xff]);
      const bytes = side === "prefix"
        ? Buffer.concat([Buffer.from("# "), invalid, Buffer.from("\n" + text)])
        : Buffer.concat([Buffer.from(text + '\n[other]\nx = "'), invalid, Buffer.from('"\n')]);
      seed("");
      writeFileSync(cfgPath(), bytes);
      const result = wireCodex(ENV_B);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("~/.codex/config.toml");
      expect(result.message).toContain("edit the [mcp_servers.flair] section by hand");
      expect(readFileSync(cfgPath())).toEqual(bytes);
      expect(readdirSync(join(isoHome, ".codex"))).toEqual(["config.toml"]);
    });
  }
});

// The fixture checks below use the runtime's own TOML parser as an oracle. The Bun version the repo
// pins (packageManager) decodes no \U escapes and accepts a redefined table, so each check runs only
// where the parser implements that part of TOML 1.0; the refusal itself is asserted on every runtime.
const TOML_DECODES_U_ESCAPES = (() => {
  try { return (Bun.TOML.parse('a = "\\U00000066"') as any).a === "f"; } catch { return false; }
})();
const TOML_REJECTS_REDEFINED_TABLE = (() => {
  try { Bun.TOML.parse("[a]\nx = 1\n\n[a]\ny = 2\n"); return false; } catch { return true; }
})();
const TOML_READS_ESCAPED_TRIPLE_QUOTES = (() => {
  try { return (Bun.TOML.parse('a = """\n\\"""\n"""\n') as any).a === '"""\n'; } catch { return false; }
})();

describe("Codex pre-header multiline delimiters", () => {
  for (const env of [ENV_A, ENV_B]) {
    for (const quote of ['"""', "'''"]) {
      it(`refuses a fake section inside ${quote} for ${env.FLAIR_AGENT_ID}`, () => {
        const raw = seed([
          `description = ${quote}`,
          quote === '"""' ? '\\"""' : "\\''",
          tomlSnippet(ENV_A),
          "[after]",
          quote,
          "",
        ].join("\n"));
        if (quote === "'''" || TOML_READS_ESCAPED_TRIPLE_QUOTES) {
          expect((Bun.TOML.parse(raw) as any).mcp_servers).toBeUndefined();
        }
        const bytes = readFileSync(cfgPath());
        const result = wireCodex(env);
        expect(result.message).toContain("multiline-string delimiters precede");
        expectRefusal(raw, result);
        expect(readFileSync(cfgPath())).toEqual(bytes);
      });

      it(`refuses a section after a closed ${quote} preamble for ${env.FLAIR_AGENT_ID}`, () => {
        const raw = seed(`description = ${quote}text${quote}\n${tomlSnippet(ENV_A)}\n`);
        expect((Bun.TOML.parse(raw) as any).mcp_servers.flair.env.FLAIR_AGENT_ID).toBe("agent-a");
        expectRefusal(raw, wireCodex(env));
      });
    }
  }
});

describe("Codex fallback definition guard", () => {
  for (const header of [
    '[mcp_servers."\\u0066lair"]', '["\\u006dcp_servers".flair]',
    '[mcp_servers."\\U00000066lair"]', "['mcp_servers'.'flair']",
    '[ "mcp_servers" . "flair" ]',
  ]) {
    for (const ending of ["\n", "\r\n"]) {
      it(`refuses the alias ${header} with ${JSON.stringify(ending)} lines`, () => {
        // Alias both headers so the canonical env header cannot cause the refusal.
        const raw = seed((tomlSnippet(ENV_A)
          .replace('[mcp_servers.flair]', header)
          .replace('[mcp_servers.flair.env]', header.slice(0, -1) + '.env]') + "\n").replaceAll("\n", ending));
        if (!header.includes("\\U") || TOML_DECODES_U_ESCAPES) {
          expect((Bun.TOML.parse(raw) as any).mcp_servers.flair.env.FLAIR_AGENT_ID).toBe("agent-a");
        }
        expectRefusal(raw, wireCodex(ENV_B));
      });
    }
  }
  for (const raw of [
    '[mcp_servers]\nflair = { command = "npx" }\n',
    '[mcp_servers]\n"\\u0066lair" = { command = "npx" }\n',
    'mcp_servers = { flair = { command = "npx" } }\n',
    '"\\u006dcp_servers" = { "\\u0066lair" = { command = "npx" } }\n',
    'mcp_servers.flair.command = "npx"\n',
    '"mcp_servers"."\\u0066lair".command = "npx"\n',
  ]) {
    it(`refuses a parent or dotted assignment ${JSON.stringify(raw)}`, () => {
      expect((Bun.TOML.parse(raw) as any).mcp_servers.flair.command).toBe("npx");
      seed(raw);
      expectRefusal(raw, wireCodex(ENV_B));
    });
  }
  for (const placement of ["before", "after"]) {
    for (const header of ['[mcp_servers.flair.extra]', '[mcp_servers.flair.env]', '[mcp_servers."\\u0066lair".extra]', '[[mcp_servers.flair.extra]]']) {
      it(`refuses ${header} ${placement} the main section`, () => {
        const extra = header + '\nextra = "value"\n\n';
        const raw = seed(placement === "before"
          ? extra + tomlSnippet(ENV_A) + "\n"
          : tomlSnippet(ENV_A) + '\n\n[other]\nx = "v"\n\n' + extra);
        if (header.endsWith('.env]')) {
          if (TOML_REJECTS_REDEFINED_TABLE) expect(() => Bun.TOML.parse(raw)).toThrow();
        } else {
          const extra = (Bun.TOML.parse(raw) as any).mcp_servers.flair.extra;
          expect((Array.isArray(extra) ? extra[0] : extra).extra).toBe("value");
        }
        expectRefusal(raw, wireCodex(ENV_B));
      });
    }
  }
  for (const present of [true, false]) {
    it(`refuses a corrupted candidate shape on ${present ? "replacement" : "append"}`, () => {
      const raw = seed(present ? tomlSnippet(ENV_A) + "\n" : '# empty config\n');
      const res = wireCodex(ENV_B, { beforeShapeCheck: text => text.replace('command = "npx"', 'command = "bad"') });
      expect(res.ok).toBe(false);
      expect(res.message).toContain("replacement is not the intended Flair section");
      expect(readFileSync(cfgPath(), "utf8")).toBe(raw);
      expect(readdirSync(join(isoHome, ".codex"))).toEqual(["config.toml"]);
    });
  }
});
