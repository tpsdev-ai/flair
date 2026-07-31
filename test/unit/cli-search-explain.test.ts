// cli-search-explain.test.ts — Flair #992
//
// `flair search --explain` was a silent no-op for every non-TTY caller.
// render.resolveOutputMode() maps non-TTY stdout to json mode, and the search
// action returns early on json mode — before the explain block ever runs. So
// every script, agent, CI job and `| less` got no breakdown and no error:
// absence rendering as success.
//
// These tests spawn the real CLI against a mock HTTP server. `spawn` gives the
// child a PIPE for stdout, so process.stdout.isTTY is false — that is the exact
// broken path, and it is the only path these tests exercise. A test that forced
// FLAIR_OUTPUT=human would pass with the defect still in place.
//
// Also covers the second half of #992: the breakdown must not mislabel a raw
// score as "composite", and must not report retrievalCount, which flair#683
// removed from the scoring formula outright.

import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { buildSearchExplain, formatSearchExplain, searchScoringFormula } from "../../src/cli.js";

const HIT = {
  id: "m1",
  content: "Harper v5 sandbox blocks node:module but process.dlopen works",
  agentId: "a",
  durability: "permanent",
  createdAt: "2026-05-01T00:00:00.000Z",
  usageCount: 3,
  retrievalCount: 11,
  tags: ["sandbox"],
  subject: "runtime",
  _score: 0.812,
  _rawScore: 0.744,
};

function startMockServer(payload: unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// stdout is a pipe here, never a TTY — that is the point of this harness.
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["src/cli.ts", ...args], { cwd: ".", env });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

async function searchWith(args: string[], results: unknown[]) {
  const { server, url } = await startMockServer({ results });
  try {
    const r = await runCli(args, {
      ...process.env,
      FLAIR_URL: url,
      FLAIR_AGENT_ID: "",
      // Deliberately NOT setting FLAIR_OUTPUT: the resolved mode must come
      // from TTY detection, which is what the bug hinged on.
      FLAIR_OUTPUT: "",
    });
    return r;
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

describe("flair search --explain over a non-TTY stdout (flair#992)", () => {
  it("emits a per-hit _explain block when piped, instead of silently dropping the flag", async () => {
    const { code, stdout } = await searchWith(
      ["search", "sandbox", "--agent", "a", "--explain"],
      [HIT],
    );
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    // The whole bug: before the fix this key did not exist on any non-TTY run.
    expect(parsed[0]._explain).toBeDefined();
    expect(parsed[0]._explain.scoring).toBe("raw");
    expect(parsed[0]._explain.durability).toBe("permanent");
    expect(parsed[0]._explain.usageCount).toBe(3);
    expect(typeof parsed[0]._explain.ageDays).toBe("number");
  });

  it("emits _explain under --explain --json too", async () => {
    const { code, stdout } = await searchWith(
      ["search", "sandbox", "--agent", "a", "--explain", "--json"],
      [HIT],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed[0]._explain).toBeDefined();
    expect(parsed[0]._explain.formula).toBe("cosine similarity only");
  });

  it("reports composite and raw as separate terms under --scoring composite", async () => {
    const { code, stdout } = await searchWith(
      ["search", "sandbox", "--agent", "a", "--explain", "--scoring", "composite"],
      [HIT],
    );
    expect(code).toBe(0);
    const ex = JSON.parse(stdout)[0]._explain;
    expect(ex.scoring).toBe("composite");
    expect(ex.raw).toBe(0.744); // _rawScore — the pre-composite semantic score
    expect(ex.composite).toBe(0.812); // _score
  });

  it("never labels a raw score 'composite' under the default raw scoring", async () => {
    // Under --scoring raw the server puts the raw score in _score and omits
    // _rawScore. The pre-#992 renderer printed that as `composite=`.
    const rawHit = { ...HIT, _score: 0.744, _rawScore: undefined };
    const { stdout } = await searchWith(
      ["search", "sandbox", "--agent", "a", "--explain"],
      [rawHit],
    );
    const ex = JSON.parse(stdout)[0]._explain;
    expect(ex.raw).toBe(0.744);
    expect(ex.composite).toBeUndefined();
  });

  it("does not report retrievalCount as a scoring term (flair#683 removed it)", async () => {
    const { stdout } = await searchWith(
      ["search", "sandbox", "--agent", "a", "--explain"],
      [HIT],
    );
    const ex = JSON.parse(stdout)[0]._explain;
    expect(ex.retrievalCount).toBeUndefined();
    expect(ex.retrievals).toBeUndefined();
    expect(JSON.stringify(ex)).not.toContain("retrieval");
  });

  it("leaves JSON output byte-identical when --explain is absent", async () => {
    // Positive control for the opt-in claim: the widened shape must appear
    // ONLY when the caller typed the flag.
    const { stdout } = await searchWith(["search", "sandbox", "--agent", "a"], [HIT]);
    const parsed = JSON.parse(stdout);
    expect(parsed[0]._explain).toBeUndefined();
    expect(parsed[0]).toEqual(HIT as any);
  });
});

describe("buildSearchExplain / formatSearchExplain (flair#992)", () => {
  const NOW = Date.parse("2026-05-11T00:00:00.000Z"); // 10 days after HIT.createdAt

  it("derives ageDays from createdAt", () => {
    expect(buildSearchExplain(HIT, "raw", NOW).ageDays).toBe(10);
  });

  it("omits ageDays when createdAt is absent or unparseable", () => {
    expect(buildSearchExplain({ ...HIT, createdAt: undefined }, "raw", NOW).ageDays).toBeUndefined();
    expect(buildSearchExplain({ ...HIT, createdAt: "not-a-date" }, "raw", NOW).ageDays).toBeUndefined();
  });

  it("defaults durability and usageCount rather than emitting undefined terms", () => {
    const ex = buildSearchExplain({ _score: 0.5 }, "raw", NOW);
    expect(ex.durability).toBe("standard");
    expect(ex.usageCount).toBe(0);
  });

  it("names the usage boost, not the retrieval boost, in the composite formula", () => {
    expect(searchScoringFormula("composite")).toContain("usage-boost");
    expect(searchScoringFormula("composite")).not.toContain("retrieval");
    expect(searchScoringFormula("raw")).toBe("cosine similarity only");
  });

  it("renders the same terms in the human one-liner", () => {
    const line = formatSearchExplain(buildSearchExplain(HIT, "composite", NOW), HIT);
    expect(line).toContain("raw=0.744");
    expect(line).toContain("composite=0.812");
    expect(line).toContain("durability=permanent");
    expect(line).toContain("age=10d");
    expect(line).toContain("usage=3");
    expect(line).not.toContain("retrievals=");
  });
});
