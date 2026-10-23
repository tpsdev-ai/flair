// check-cli-spawn-budgets-runtime-2782.test.ts — the spawn-budget gate's options
// rule (flair#2782) checked against real runtimes. Each shape is written once and
// used twice: as the options of a CLI-entry spawn the gate reads, and as the
// options of a real Node `child_process.spawnSync` (in a `node` process) and a
// real `Bun.spawnSync` (in a `bun` process) of a child that sleeps longer than
// the timeout. Each accepted shape here must time the child out; each rejected
// shape here must let it run to the end.

import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { findSpawnCalls } from "../../scripts/ci/check-cli-spawn-budgets.mjs";

const TIMEOUT_MS = 200;
const CHILD_SLEEP_MS = 1_500;
const CHILD = `["-e", "setTimeout(() => {}, ${CHILD_SLEEP_MS})"]`;

/** `decl` runs before the spawn (identifier forms); `opts` is the options argument. */
type Shape = { name: string; decl?: string; opts: string };

const ACCEPTED: Shape[] = [
  { name: "an object literal", opts: `{ timeout: ${TIMEOUT_MS} }` },
  { name: "a parenthesized object literal", opts: `({ timeout: ${TIMEOUT_MS} })` },
  { name: "an object literal `as` a type", opts: `{ timeout: ${TIMEOUT_MS} } as SpawnSyncOptions` },
  { name: "an object literal that `satisfies` a type", opts: `{ timeout: ${TIMEOUT_MS} } satisfies object` },
  { name: "a non-null object literal", opts: `{ timeout: ${TIMEOUT_MS} }!` },
  { name: "a quoted timeout key", opts: `{ "timeout": ${TIMEOUT_MS} }` },
  { name: "a const identifier", decl: `const opts = { timeout: ${TIMEOUT_MS} };`, opts: "opts" },
  { name: "a const identifier `as` a type", decl: `const opts = { timeout: ${TIMEOUT_MS} } as SpawnSyncOptions;`, opts: "opts" },
];

const REJECTED: Shape[] = [
  { name: "an object literal at the start of `&&`", opts: `{ timeout: ${TIMEOUT_MS} } && {}` },
  { name: "a const identifier holding `&&`", decl: `const opts = { timeout: ${TIMEOUT_MS} } && {};`, opts: "opts" },
  { name: "a later spread", opts: `{ timeout: ${TIMEOUT_MS}, ...{ timeout: undefined } }` },
  { name: "a const identifier holding a later spread", decl: `const opts = { timeout: ${TIMEOUT_MS}, ...{ timeout: undefined } };`, opts: "opts" },
  { name: "a later computed key", opts: `{ timeout: ${TIMEOUT_MS}, ["timeout"]: undefined }` },
  { name: "a const identifier mutated after its declaration", decl: `const opts = { timeout: ${TIMEOUT_MS} };\nopts.timeout = 0;`, opts: "opts" },
  { name: "a let identifier reassigned", decl: `let opts: object = { timeout: ${TIMEOUT_MS} };\nopts = {};`, opts: "opts" },
];

/** The gate's deadline for `shape` as the options of a CLI-entry spawn, per spawn family. */
function gateDeadlines(shape: Shape): Array<number | null> {
  const wrap = (call: string) => `${shape.decl ?? ""}\ntest("t", () => {\n  ${call}\n}, 120_000);\n`;
  return [
    wrap(`spawnSync("bun", ["src/cli.ts", "status"], ${shape.opts});`),
    wrap(`Bun.spawnSync(["bun", "src/cli.ts", "status"], ${shape.opts});`),
  ].map((src) => {
    const { calls } = findSpawnCalls(src);
    expect(calls.length).toBe(1);
    expect(calls[0].isCliEntry).toBe(true);
    return calls[0].timeoutMs ?? null;
  });
}

type Outcome = { runtime: string; timedOut: boolean; status: number | null; ms: number };

const RUNTIMES = [
  {
    name: "Node child_process.spawnSync",
    expectedRuntime: "node",
    command: () => "node",
    // Node runs JavaScript: the shape's type syntax is removed by TypeScript's own
    // transpiler, which leaves the runtime expression unchanged.
    script: (s: Shape) =>
      ts.transpileModule(
        `const { spawnSync } = require("node:child_process");\n${s.decl ?? ""}\n` +
          `const started = Date.now();\nconst r = spawnSync(process.execPath, ${CHILD}, ${s.opts});\n` +
          `console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", timedOut: r.error?.code === "ETIMEDOUT", status: r.status, ms: Date.now() - started }));\n`,
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
      ).outputText,
  },
  {
    name: "Bun.spawnSync",
    expectedRuntime: "bun",
    command: () => process.execPath,
    script: (s: Shape) =>
      `${s.decl ?? ""}\nconst started = Date.now();\nconst r = Bun.spawnSync([process.execPath, ...${CHILD}], ${s.opts});\n` +
      `console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", timedOut: r.exitedDueToTimeout === true, status: r.exitCode, ms: Date.now() - started }));\n`,
  },
];

/** Runs `shapes` under one runtime, all at once, and returns each outcome by shape name. */
async function runShapes(runtime: (typeof RUNTIMES)[number], shapes: Shape[]): Promise<Map<string, Outcome>> {
  const outcomes = await Promise.all(
    shapes.map(async (shape) => {
      const proc = Bun.spawn([runtime.command(), "-e", runtime.script(shape)], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, `${runtime.name}, ${shape.name}: ${stderr}`).toBe(0);
      return [shape.name, JSON.parse(stdout) as Outcome] as const;
    }),
  );
  return new Map(outcomes);
}

describe("accepted and rejected options shapes: the gate's reading matches real spawnSync behaviour (flair#2782)", () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime.name}: each accepted shape times the child out`, async () => {
      const outcomes = await runShapes(runtime, ACCEPTED);
      for (const shape of ACCEPTED) {
        expect(gateDeadlines(shape), shape.name).toEqual([TIMEOUT_MS, TIMEOUT_MS]);
        const o = outcomes.get(shape.name)!;
        expect(o.runtime, shape.name).toBe(runtime.expectedRuntime);
        expect(o.timedOut, shape.name).toBe(true);
        expect(o.ms, shape.name).toBeLessThan(CHILD_SLEEP_MS);
      }
    }, 60_000);

    it(`${runtime.name}: each rejected shape lets the child run to the end`, async () => {
      const outcomes = await runShapes(runtime, REJECTED);
      for (const shape of REJECTED) {
        expect(gateDeadlines(shape), shape.name).toEqual([null, null]);
        const o = outcomes.get(shape.name)!;
        expect(o.runtime, shape.name).toBe(runtime.expectedRuntime);
        expect(o.timedOut, shape.name).toBe(false);
        expect(o.status, shape.name).toBe(0);
        expect(o.ms, shape.name).toBeGreaterThanOrEqual(CHILD_SLEEP_MS);
      }
    }, 60_000);
  }
});
