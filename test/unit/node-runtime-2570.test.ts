import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nodeBin } from "../helpers/node-runtime.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function configured(executable: string | undefined, run: () => void) {
  const previous = process.env.NODE_BIN;
  if (executable === undefined) delete process.env.NODE_BIN;
  else process.env.NODE_BIN = executable;
  try { run(); }
  finally {
    if (previous === undefined) delete process.env.NODE_BIN;
    else process.env.NODE_BIN = previous;
  }
}

test("nodeBin verifies real Node and the Bun-runner fallback", () => {
  configured(Bun.which("node")!, () => {
    expect(execFileSync(nodeBin(), ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5_000 }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  configured(undefined, () => expect(nodeBin()).toBe(realpathSync(Bun.which("node")!)));
});

test("nodeBin refuses Bun reached through a symlink", () => {
  const alias = join(tempDir("flair-node-runtime-"), "runtime");
  symlinkSync(process.execPath, alias);
  configured(alias, () => expect(() => nodeBin()).toThrow("refused non-Node executable"));
});

test("nodeBin returns the direct Node path for a symlink selected through the child PATH", () => {
  const root = tempDir("flair-node-runtime-");
  const node = realpathSync(Bun.which("node")!);
  symlinkSync(node, join(root, "runtime"));
  expect(nodeBin({ env: { ...process.env, PATH: root, NODE_BIN: "runtime" }, cwd: root })).toBe(node);
});

test("nodeBin identifies the current Bun runtime through an alias", () => {
  const root = tempDir("flair-node-runtime-");
  const alias = join(root, "RUNTIME");
  symlinkSync(process.execPath, alias);
  const env = { ...process.env };
  delete env.NODE_BIN;
  const helper = resolve(import.meta.dir, "../helpers/node-runtime.ts");
  const output = execFileSync(alias, ["-e", `import { nodeBin } from ${JSON.stringify(helper)}; console.log(nodeBin())`], {
    encoding: "utf8", timeout: 5_000, env,
  });
  expect(output.trim()).toBe(realpathSync(Bun.which("node")!));
});

test("nodeBin uses process.execPath when the current runtime is Node", () => {
  const node = Bun.which("node")!;
  const env = { ...process.env };
  delete env.NODE_BIN;
  const helper = resolve(import.meta.dir, "../helpers/node-runtime.ts");
  const output = execFileSync(node, ["--input-type=module", "-e", `import { nodeBin } from ${JSON.stringify(helper)}; console.log(nodeBin() === process.execPath)`], {
    encoding: "utf8", timeout: 5_000, env,
  });
  expect(output.trim()).toBe("true");
});

test("nodeBin refuses echo and a missing executable", () => {
  configured("/bin/echo", () => expect(() => nodeBin()).toThrow("refused non-Node executable"));
  configured(join(tempDir("flair-node-runtime-"), "missing"), () => expect(() => nodeBin()).toThrow("cannot verify Node executable"));
});

test("nodeBin bounds a stalled identity probe", () => {
  const executable = join(tempDir("flair-node-runtime-"), "stall");
  writeFileSync(executable, `#!${Bun.which("node")}\nsetInterval(() => {}, 1000)`, { mode: 0o755 });
  configured(executable, () => expect(() => nodeBin()).toThrow("cannot verify Node executable"));
});

for (const context of ["environment", "working directory"]) {
  test(`nodeBin probes a launcher in the child ${context}`, () => {
    const root = tempDir("flair-node-runtime-");
    const runtime = join(root, "runtime");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const parentOnly = "FLAIR_NODE_PARENT_ONLY";
    const previous = process.env[parentOnly];
    process.env[parentOnly] = "1";
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_BIN: "./runtime" };
    delete env[parentOnly];
    const condition = context === "environment" ? `[ "$${parentOnly}" = 1 ]` : `[ "$PWD" != ${quote(root)} ]`;
    writeFileSync(runtime, `#!/bin/sh\nif ${condition}; then exec ${quote(Bun.which("node")!)} "$@"; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    try {
      configured(runtime, () => expect(() => nodeBin()).toThrow("cannot verify direct Node executable"));
      expect(() => nodeBin({ env, cwd: root })).toThrow("refused non-Node executable");
      env.NODE_BIN = Bun.which("node")!;
      expect(execFileSync(nodeBin({ env, cwd: root }), ["-p", "process.versions.bun ? 'bun' : 'node'"], {
        env, cwd: root, encoding: "utf8", timeout: 5_000,
      }).trim()).toBe("node");
    } finally {
      if (previous === undefined) delete process.env[parentOnly];
      else process.env[parentOnly] = previous;
    }
  });
}
