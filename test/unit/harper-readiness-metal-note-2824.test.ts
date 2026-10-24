// flair#2824 — a readiness timeout names the embedding engine's Metal library
// compile when the captured Harper log shows one.
//
// On a fresh CI macOS runner ggml's Metal library compile ran inside the first
// test Harper's readiness wait, which then ran out. The log lines below are ggml's own
// (as harper-fabric-embeddings 0.5.0's addon prints them). The parser cases need
// no Harper; the startHarper cases boot a stub `harper.js` that installs, logs
// those lines and never answers /health, so the real readiness wait times out.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metalLibraryCompileNote, startHarper } from "../helpers/harper-lifecycle.js";

const STARTED = "ggml_metal_library_init: using embedded metal library";
const LOADED = (sec: string) => `ggml_metal_library_init: loaded in ${sec} sec`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A root whose node_modules/harper/dist/bin/harper.js installs at once and, on `run`, logs `lines` and stays up. */
function stubHarperRoot(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "flair-2824-stub-"));
  dirs.push(root);
  const bin = join(root, "node_modules", "harper", "dist", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "harper.js"),
    [
      `if (process.argv[2] === "install") process.exit(0);`,
      `console.log("Domain socket listening on stub");`,
      ...lines.map((line) => `console.error(${JSON.stringify(line)});`),
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return root;
}

async function readinessFailure(lines: string[]): Promise<string> {
  const root = stubHarperRoot(lines);
  try {
    await startHarper({ cwd: root, harperBinDir: root, readinessTimeoutMs: 1_000 });
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("startHarper resolved against a stub that never answers /health");
}

describe("flair#2824: the Metal library compile note", () => {
  test("a finished compile reports the duration from the last 'loaded in' line", () => {
    expect(metalLibraryCompileNote(`x\n${STARTED}\n${LOADED("39.981")}\ny`)).toBe(
      "the embedding engine's Metal library compile (ggml_metal_library_init) took 39.981 s",
    );
    expect(metalLibraryCompileNote(`${STARTED}\n${LOADED("0.025")}\n${STARTED}\n${LOADED("12.5")}`)).toContain("took 12.5 s");
  });

  test("a compile that started and logged no 'loaded in' line says so", () => {
    expect(metalLibraryCompileNote(`[http/1] [info]: Loading application\n${STARTED}\n`)).toBe(
      `the embedding engine's Metal library compile (ggml_metal_library_init) started and logged no "loaded in" line`,
    );
  });

  test("a log with no ggml_metal_library_init line yields no note", () => {
    expect(metalLibraryCompileNote("")).toBeNull();
    expect(metalLibraryCompileNote("ggml_metal_device_init: GPU name:   MTL0\nloaded in 3 sec")).toBeNull();
  });
});

describe("flair#2824: the readiness timeout carries the note", () => {
  test("an unfinished compile is named after the process state, before the Harper log", async () => {
    const message = await readinessFailure([STARTED]);
    expect(message).toMatch(/^Harper at http:\/\/127\.0\.0\.1:\d+ did not respond within 1000ms \(/);
    expect(message).toContain(
      `Process still alive. Captured log: the embedding engine's Metal library compile (ggml_metal_library_init) started and logged no "loaded in" line. Harper log:\n`,
    );
  }, 15_000);

  test("a finished compile is named with its duration", async () => {
    const message = await readinessFailure([STARTED, LOADED("39.981")]);
    expect(message).toContain("Captured log: the embedding engine's Metal library compile (ggml_metal_library_init) took 39.981 s. Harper log:\n");
  }, 15_000);

  test("a log without the compile lines keeps the message without a note", async () => {
    const message = await readinessFailure([]);
    expect(message).toContain("Process still alive. Harper log:\n");
    expect(message).not.toContain("Captured log:");
  }, 15_000);
});
