/**
 * pin-refresh-write-failure-1834.test.ts — flair#1834 A2 round 2 (CodeRabbit MAJOR).
 *
 * THE DEFECT. The shared in-lock pin-only wrapper (`repinPinOnly`) stored the
 * classifier's "repinned" verdict in `settled` BEFORE the write committed. If
 * `atomicReplace` then refused (a staging failure, a non-regular destination, a
 * rename failure), the wrapper still returned the stored "repinned" — so
 * `refreshOwnedPins` reported `action: "update", ok: true` ("re-pinned …") while
 * the file still held the old pin. A failed write reported as success.
 *
 * THE FIX. A decided re-pin is truthful ONLY for a committed write; a failure
 * after the decision is reported as `failed` (action skip, `ok: false`, loud).
 * This is the SHARED seam both writers use — the JSON path (`repinJsonMcpPin`)
 * and the Codex TOML path (`repinCodexPin`) — so one fix covers both.
 *
 * RED on d8f04172: the result is `update`/`ok: true` and the line says
 * "re-pinned", though the write was refused and the file is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshOwnedPins, ownedPinRefreshShouldReport } from "../../src/lib/owned-pins.ts";
import { clientConfigPath } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec, flairCliVersion } from "../../src/lib/mcp-spec.ts";
import { parseSemverCore } from "../../src/fabric-upgrade.ts";

const CURRENT_SPEC = mcpServerSpec();
const core = parseSemverCore(flairCliVersion());
if (!core) throw new Error(`CLI version is not semver: ${flairCliVersion()}`);
const STALE_VER = core[2] > 0 ? `${core[0]}.${core[1]}.${core[2] - 1}` : `${core[0]}.${core[1] - 1}.0`;
const STALE_SPEC = `${FLAIR_MCP_PACKAGE}@${STALE_VER}`;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-1834-a2-wfail-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

function writeRaw(id: string, text: string): string {
  const p = clientConfigPath(id as never);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}
function writeJson(id: string, entry: unknown): string {
  return writeRaw(id, JSON.stringify({ mcpServers: { flair: entry } }, null, 2) + "\n");
}
function readEntry(id: string): any {
  return JSON.parse(readFileSync(clientConfigPath(id as never), "utf-8")).mcpServers?.flair;
}

// The primitive's OWN fixture seam (see codex-toml-atomicity.test.ts T1b): fires
// right after the staging temp exists and before any bytes are written. A throw
// makes atomicReplace REFUSE — a write failure that lands AFTER the decision.
const FAIL_WRITE = {
  afterTempCreate: () => { throw new Error("simulated staged-write failure"); },
};

describe("flair#1834 A2 round 2 — a refused write after the re-pin decision is a FAILURE", () => {
  it("JSON path: failed (ok false, printed), file unchanged, never 're-pinned'", () => {
    const entry = { command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_AGENT_ID: "keepme" } };
    const p = writeJson("claude-code", entry);
    const before = readFileSync(p, "utf-8");

    const results = refreshOwnedPins({
      homeDir: isoHome,
      targets: [{ kind: "mcp-client", id: "claude-code" }],
      testHooks: FAIL_WRITE,
    });

    const r = results.find((x) => x.target.id === "claude-code")!;
    expect(readFileSync(p, "utf-8")).toBe(before);      // nothing was written
    expect(r.action).toBe("skip");                      // failed -> skip
    expect(r.ok).toBe(false);                           // ... ok FALSE
    expect(r.message).not.toContain("re-pinned");       // never a false success
    expect(r.message).toContain("Claude Code");
    expect(ownedPinRefreshShouldReport(r)).toBe(true);  // ... and it PRINTS
  });

  it("Codex path: failed (ok false, printed), file unchanged, never 're-pinned'", () => {
    const p = writeRaw("codex",
      `[mcp_servers.flair]\ncommand = "npx"\nargs = ["-y", "${STALE_SPEC}"]\n\n[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "codexbot"\n`);
    const before = readFileSync(p, "utf-8");

    const results = refreshOwnedPins({
      homeDir: isoHome,
      targets: [{ kind: "mcp-client", id: "codex" }],
      testHooks: FAIL_WRITE,
    });

    const r = results.find((x) => x.target.id === "codex")!;
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(r.action).toBe("skip");
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("re-pinned");
    expect(r.message).toContain("Codex");
    expect(ownedPinRefreshShouldReport(r)).toBe(true);
  });

  it("CONTROL: with the write allowed, the same fixture reports update/ok and advances the pin", () => {
    const entry = { command: "npx", args: ["-y", STALE_SPEC], env: { FLAIR_AGENT_ID: "keepme" } };
    writeJson("claude-code", entry);

    const results = refreshOwnedPins({ homeDir: isoHome, targets: [{ kind: "mcp-client", id: "claude-code" }] });
    const r = results.find((x) => x.target.id === "claude-code")!;
    expect(r.action).toBe("update");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("re-pinned");

    const after = readEntry("claude-code");
    expect(after.args[1]).toBe(CURRENT_SPEC);
    expect(after.env.FLAIR_AGENT_ID).toBe("keepme");
  });
});
