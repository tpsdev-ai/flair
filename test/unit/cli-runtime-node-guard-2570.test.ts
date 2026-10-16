import { describe, expect, spyOn, test } from "bun:test";
import childProcess, { exec, execSync, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { nodeBin } from "../helpers/node-runtime.ts";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { tempDir } from "../helpers/temp-dir.ts";

const cjs = createRequire(import.meta.url)("node:child_process");
const harperRoot = resolve(dirname(createRequire(import.meta.url).resolve("harper")), "..");
const harperEntry = realpathSync(resolve(harperRoot, JSON.parse(readFileSync(join(harperRoot, "package.json"), "utf8")).bin.harper));

function fixture() {
  const root = tempDir("flair-runtime-guard-");
  mkdirSync(join(root, "dist"));
  const cli = join(root, "dist", "cli.js");
  const code = "console.log(JSON.stringify(process.argv.slice(2)))";
  writeFileSync(cli, code);
  writeFileSync(join(root, "dist", "cli-shim.cjs"), code);
  writeFileSync(join(root, "harper.js"), code);
  writeFileSync(join(root, "source-cli.js"), code);
  return { root, cli };
}

function refused(call: () => unknown, api = "child_process.spawnSync", name = "BunHarperSpawnError") {
  let caught: unknown;
  try { call(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.name).toBe(name);
  expect(error.message).toContain(api);
  expect(error.stack).toContain("cli-runtime-node-guard-2570.test.ts:");
  return error;
}

function allowed(cli: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5_000 });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
}

describe("Bun Harper spawn preload", () => {
  test("promisified execFile retains output fields and the child handle", async () => {
    const pending = promisify(execFile)(process.execPath, ["-e", "console.log(42)"], { timeout: 5_000 });
    expect(pending.child.pid).toBeGreaterThan(0);
    expect(await pending).toEqual({ stdout: "42\n", stderr: "" });
  }, 20_000);
  test("promisified execFile refuses init for an argument-printing script standing in for the CLI entry", async () => {
    const { cli } = fixture();
    await expect(promisify(execFile)(process.execPath, [cli, "init"], { timeout: 5_000 })).rejects.toMatchObject({
      name: "BunHarperSpawnError", message: expect.stringContaining("child_process.execFile"),
      stack: expect.stringContaining("cli-runtime-node-guard-2570.test.ts:"),
    });
  }, 20_000);
  test("a missing executable retains its native spawn error", () => {
    const { root, cli } = fixture();
    const result = spawnSync(join(root, "missing"), [cli, "init"], { timeout: 5_000 });
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }, 20_000);
  for (const [flag, source] of [["--eval", "console.log(42)"], ["--print", "42"]]) {
    test(`${flag} treats a CLI entry argument as data`, () => {
      const { cli } = fixture();
      const result = spawnSync(process.execPath, [flag, source, cli, "init"], {
        encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("42\n");
    }, 20_000);
  }
  test("package test runners install the guard", () => {
    const packages = resolve(import.meta.dir, "../../packages");
    const dirs = readdirSync(packages).filter(name => existsSync(join(packages, name, "bunfig.toml")));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const result = Bun.spawnSync([process.execPath, "test", import.meta.filename,
        "--test-name-pattern", "named child_process.spawn refuses init for an argument-printing script standing in for the CLI entry"], {
        cwd: join(packages, dir), timeout: 5_000, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, dir).toBe(0);
      expect(result.stderr.toString(), dir).toContain("1 pass");
    }
  }, 60_000);
  for (const [label, fn] of Object.entries({ spawn, spawnSync, execFile, execFileSync })) {
    test(`named child_process.${label} refuses init for an argument-printing script standing in for the CLI entry`, () => {
      const { cli } = fixture();
      refused(() => Reflect.apply(fn, undefined, [process.execPath, [cli, "init"]]), `child_process.${label}`);
    }, 20_000);
    for (const [kind, object] of [["default", childProcess], ["require", cjs]] as const) {
      test(`${kind} child_process.${label} refuses init for an argument-printing script standing in for the CLI entry`, () => {
        const { cli } = fixture();
        refused(() => Reflect.apply(object[label], object, [process.execPath, [cli, "init"]]), `child_process.${label}`);
      }, 20_000);
    }
  }
  for (const api of ["spawn", "spawnSync"] as const) {
    test(`Bun.${api} refuses array and object commands`, () => {
      const { cli } = fixture();
      const cmd = [process.execPath, cli, "init"];
      refused(() => Reflect.apply(Bun[api], Bun, [cmd]), `Bun.${api}`);
      refused(() => Reflect.apply(Bun[api], Bun, [{ cmd }]), `Bun.${api}`);
    }, 20_000);
  }

  test("aliased runtime variable is refused", () => {
    const { cli } = fixture();
    const runtime = process.execPath;
    refused(() => spawnSync(runtime, [cli, "init"], { timeout: 5_000 }));
  }, 20_000);
  test("wrapper function is refused", () => {
    const { cli } = fixture();
    const run = (runtime: string, args: string[]) => spawnSync(runtime, args, { timeout: 5_000 });
    refused(() => run(process.execPath, [cli, "init"]));
  }, 20_000);
  test("direct bun and env bun invocations of an argument-printing CLI fixture are refused", () => {
    const { cli } = fixture();
    refused(() => spawnSync("bun", [cli, "init"], { timeout: 5_000 }));
    for (const prefix of [[], ["-i"], ["-u", "UNUSED"], ["--unset=UNUSED"], ["-C", dirname(cli)], ["--"]]) {
      refused(() => spawnSync("/usr/bin/env", [...prefix, `PATH=${process.env.PATH}`, "UNUSED=value", "bun", cli, "init"], { timeout: 5_000 }));
    }
  }, 20_000);
  for (const form of ["-S", "-SSTRING", "--split-string", "--split-string="]) {
    test(`env ${form} refuses Bun running an argument-printing CLI fixture`, () => {
      const { cli } = fixture();
      const source = `bun '${cli}' init`;
      const args = form === "-SSTRING" ? [`-S${source}`]
        : form.endsWith("=") ? [form + source] : [form, source];
      refused(() => spawnSync("/usr/bin/env", args, { timeout: 5_000 }));
    }, 20_000);
  }
  test("unclassifiable env forms fail closed with a named reason", () => {
    const { cli } = fixture();
    for (const [args, reason] of [
      [["-P", "/unclassified", "bun", cli, "init"], "unsupported env option"],
      [["-S"], "missing env split string"],
      [["-S", "'unterminated"], "unclassifiable env split string"],
      [["-S", ""], "unclassifiable env split string"],
      [["-u"], "missing env option operand"],
      [["UNUSED=value"], "missing env executable"],
      [["flair-missing-runtime-2571", cli, "init"], "unresolved env executable"],
      [["env", "bun", cli, "init"], "unsupported nested env wrapper"],
    ] as const) {
      const error = refused(() => spawnSync("/usr/bin/env", [...args], { timeout: 5_000 }),
        "child_process.spawnSync", "TestRuntimeIdentityError");
      expect(error.message).toContain(reason);
    }
  }, 20_000);
  test("real env -S runs Node and an explicitly overridden Bun CLI fixture", () => {
    const { cli } = fixture();
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const runtime of [Bun.which("node")!, process.execPath]) {
        const result = spawnSync("/usr/bin/env", ["-S", `'${runtime}' '${cli}' init`], {
          encoding: "utf8", timeout: 5_000,
          env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise real env split string" },
        });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["init"]);
      }
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  }, 20_000);
  test("spawn errors, stacks and warnings omit secret arguments in direct, env and shell forms", () => {
    const { root, cli } = fixture();
    const marker = "SECRET_ARGUMENT_2571";
    const unknown = join(root, "runtime");
    writeFileSync(unknown, `#!/bin/sh\nif [ "$1" = "-p" ]; then exit 1; fi\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const runtime of [process.execPath, unknown]) {
        const shell = `'${runtime}' '${cli}' init --admin-pass '${marker}'`;
        const cases = [
          { command: runtime, args: [cli, "init", "--admin-pass", marker] },
          { command: "/usr/bin/env", args: [runtime, cli, "init", "--admin-pass", marker] },
          { command: "/usr/bin/env", args: ["-S", shell] },
          { command: shell, args: [], shell: true },
          { command: "/bin/sh", args: ["-c", shell] },
        ];
        for (const form of cases) {
          const options = { shell: form.shell, timeout: 5_000, encoding: "utf8" as const };
          const error = refused(() => spawnSync(form.command, form.args, options),
            "child_process.spawnSync", runtime === unknown ? "TestRuntimeIdentityError" : "BunHarperSpawnError");
          expect(error.message).toContain("launching dist/cli.js");
          expect(error.message).not.toContain(marker);
          expect(error.stack).not.toContain(marker);
          expect(error.message).not.toContain(root);
          const result = spawnSync(form.command, form.args, { ...options,
            env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise redacted warning" },
          });
          expect(result.status).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(["init", "--admin-pass", marker]);
        }
      }
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).not.toContain(marker);
    } finally { log.mockRestore(); }
  }, 40_000);
  test("shell strings beginning with bun refuse an argument-printing script standing in for the CLI entry", () => {
    const { cli } = fixture();
    for (const prefix of ["", "UNUSED=value "]) {
      const command = `${prefix}bun '${cli}' init`;
      refused(() => spawnSync(command, { shell: true, timeout: 5_000 }));
      for (const shell of ["/bin/sh", "/bin/bash"]) {
        refused(() => spawnSync(shell, ["-c", command], { timeout: 5_000 }));
      }
    }
  }, 20_000);
  test("a compound shell command launching the built CLI under Bun is refused with a reason", () => {
    ensureCliBuild();
    const cli = resolve(import.meta.dir, "../../dist/cli.js");
    const error = refused(() => spawnSync(`true; bun '${cli}' status`, [], { shell: true, timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    expect(error.message).toContain("unclassifiable shell string");
  }, 20_000);
  for (const shell of ["shell: true", "/bin/sh", "/bin/bash"]) {
    for (const syntax of ["glob", "command substitution", "literal Bun"]) {
      test(`${shell} refuses ${syntax} with a reason`, () => {
        const { root, cli } = fixture();
        symlinkSync(process.execPath, join(root, "bun"));
        const executable = syntax === "glob" ? "./b*n"
          : syntax === "command substitution" ? "$(printf '%s' './bun')" : "./bun";
        const command = `${executable} '${cli}' status`;
        const executableShell = shell === "shell: true" ? command : shell;
        const args = shell === "shell: true" ? [] : [shell === "/bin/bash" ? "-ec" : "-c", command];
        const options = { cwd: root, shell: shell === "shell: true", encoding: "utf8" as const, timeout: 5_000 };
        const unguarded = execFileSync(nodeBin(), ["-e",
          "const [command,args,options] = JSON.parse(process.argv[1]); const result = require('node:child_process').spawnSync(command,args,options); process.stdout.write(result.stdout); process.exit(result.status ?? 1);",
          JSON.stringify([executableShell, args, options]),
        ], { encoding: "utf8", timeout: 10_000 });
        expect(JSON.parse(unguarded)).toEqual(["status"]);
        const error = refused(() => spawnSync(executableShell, args, options),
          "child_process.spawnSync", syntax === "literal Bun" ? "BunHarperSpawnError" : "TestRuntimeIdentityError");
        expect(error.message).toContain(syntax === "literal Bun" ? "launching dist/cli.js" : "unclassifiable shell string");
      }, 20_000);
    }
    test(`${shell} refuses unresolved shell executables with a reason`, () => {
      const { root, cli } = fixture();
      for (const executable of [join(root, "missing"), "flair-missing-runtime-2603"]) {
        for (const entry of ["", ` '${cli}' status`]) {
          const command = `'${executable}'${entry}`;
          const error = refused(() => spawnSync(shell === "shell: true" ? command : shell,
            shell === "shell: true" ? [] : [shell === "/bin/bash" ? "-ec" : "-c", command], {
              shell: shell === "shell: true", timeout: 5_000,
              env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "unresolved shell commands cannot be overridden" },
            }), "child_process.spawnSync", "TestRuntimeIdentityError");
          expect(error.message).toContain("unresolved shell executable");
        }
      }
    }, 20_000);
  }
  test("resolved ordinary shell commands use the child PATH", async () => {
    const { root } = fixture();
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(Bun.which("cp")!, join(bin, "copy-fixture"));
    const source = join(root, "source");
    writeFileSync(source, "ordinary command");
    for (const [index, shell] of ["shell: true", "/bin/sh", "/bin/bash"].entries()) {
      const target = join(root, `copied-${index}`);
      const command = `copy-fixture '${source}' '${target}'`;
      const result = spawnSync(shell === "shell: true" ? command : shell,
        shell === "shell: true" ? [] : ["-ec", command], {
          shell: shell === "shell: true", env: { PATH: bin }, timeout: 5_000,
        });
      expect(result.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("ordinary command");
    }
    const copied = join(root, "exec-copy");
    execSync(`cp '${source}' '${copied}'`, { timeout: 5_000 });
    expect(readFileSync(copied, "utf8")).toBe("ordinary command");
    await promisify(exec)(`rm -f '${copied}'`, { timeout: 5_000 });
    expect(existsSync(copied)).toBe(false);
    refused(() => spawnSync("copy-fixture source target", {
      shell: true, env: { PATH: root }, timeout: 5_000,
    }), "child_process.spawnSync", "TestRuntimeIdentityError");
  }, 20_000);
  for (const flag of ["-ec", "-xc", "-lc", "-excl"]) {
    test(`bash ${flag} refuses a Bun CLI fixture with a reason`, () => {
      const error = refused(() => spawnSync("/bin/bash", [flag, `'${process.execPath}' '${fixture().cli}' status`], {
        timeout: 5_000,
      }));
      expect(error.message).toContain("launching dist/cli.js");
    }, 20_000);
  }
  test("shell expansion characters are refused even when quoted or escaped", () => {
    for (const char of ["*", "?", "[", "]", "$", "`", "{", "}", "~"]) {
      for (const value of [char, `'${char}'`, `"${char}"`, `\\${char}`]) {
        const error = refused(() => spawnSync(`'${nodeBin()}' -p ${value}`, {
          shell: true, timeout: 5_000,
        }), "child_process.spawnSync", "TestRuntimeIdentityError");
        expect(error.message).toContain("unclassifiable shell string");
      }
    }
  }, 20_000);
  test("compound and ambiguous shell strings are refused with a reason", () => {
    const { cli } = fixture();
    for (const command of [
      ...[";", "&&", "||", "|", "\n", "&"].map(separator => `true ${separator} bun '${cli}' status`),
      `(bun '${cli}' status)`, `echo $(bun '${cli}' status)`,
      `echo \`bun '${cli}' status\``, `echo "$(bun '${cli}' status)"`,
      `echo "\`bun '${cli}' status\`"`, `echo $RUNTIME`,
      "echo \\\nvalue", "echo 'unterminated",
    ]) {
      for (const shell of ["/bin/sh", "/bin/bash"]) {
        const error = refused(() => spawnSync(shell, ["-c", command], { timeout: 5_000 }),
          "child_process.spawnSync", "TestRuntimeIdentityError");
        expect(error.message).toContain("unclassifiable shell string");
      }
    }
  }, 20_000);
  test("env and shell wrappers allow Node to run an argument-printing script standing in for the CLI entry", () => {
    const { cli } = fixture();
    const node = Bun.which("node")!;
    const command = `UNUSED=value '${node}' '${cli}' init`;
    const results = [
      spawnSync("/usr/bin/env", ["-u", "UNUSED", "OTHER=value", node, cli, "init"], { encoding: "utf8", timeout: 5_000 }),
      spawnSync(command, { shell: true, encoding: "utf8", timeout: 5_000 }),
      spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 5_000 }),
      spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", timeout: 5_000 }),
    ];
    for (const result of results) {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["init"]);
    }
  }, 20_000);
  test("environment-expression runtime is refused", () => {
    const { cli } = fixture();
    const env = { RUNTIME: process.execPath };
    refused(() => spawnSync(env.RUNTIME || "bun", [cli, "init"], { timeout: 5_000 }));
  }, 20_000);
  test("constructed CLI path is refused", () => {
    const { root } = fixture();
    refused(() => spawnSync(process.execPath, [resolve(root, "dist", "cli.js"), "init"], { timeout: 5_000 }));
  }, 20_000);
  test("runtime option values before the CLI entry are refused", () => {
    const { cli } = fixture();
    refused(() => spawnSync(process.execPath, ["--conditions", "x".repeat(2_000), cli, "init"], { timeout: 5_000 }));
    refused(() => spawnSync(process.execPath, ["--inspect", "127.0.0.1:0", cli, "init"], { timeout: 5_000 }));
  }, 20_000);
  test("symlinks to a CLI fixture and the installed Harper entry are refused", () => {
    const { root, cli } = fixture();
    symlinkSync(cli, join(root, "entry"));
    symlinkSync(harperEntry, join(root, "engine"));
    refused(() => spawnSync(process.execPath, [join(root, "entry"), "init"], { timeout: 5_000 }));
    refused(() => spawnSync(process.execPath, ["--cwd", root, "engine", "run", "."], { timeout: 5_000 }));
  }, 20_000);
  test("a runtime option value naming the installed Harper entry is allowed for a source fixture", () => {
    const { root } = fixture();
    const result = spawnSync(process.execPath, ["--title", harperEntry, join(root, "source-cli.js"), "init"], {
      encoding: "utf8", timeout: 5_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["init"]);
  }, 20_000);
  test("an argument-printing source-entry script with a boolean runtime flag may receive a Harper path as data", () => {
    const { root } = fixture();
    const data = [harperEntry, "run", "."];
    const result = spawnSync(process.execPath, ["--smol", join(root, "source-cli.js"), ...data], {
      encoding: "utf8", timeout: 5_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(data);
  }, 20_000);
  test("an unrelated target call does not exempt the CLI spawn", () => {
    const { root, cli } = fixture();
    refused(() => spawnSync(process.execPath, [cli, "init"], { timeout: 5_000 }));
    allowed(join(root, "source-cli.js"), ["init", "--target", "https://example.invalid"]);
  }, 20_000);
  test("a skip-start comment does not exempt the CLI spawn", () => {
    const { cli } = fixture();
    // --skip-start
    refused(() => spawnSync(process.execPath, [cli, "init"], { timeout: 5_000 }));
  }, 20_000);
  test("arguments beyond the old scan window are inspected", () => {
    const { cli } = fixture();
    refused(() => spawnSync(process.execPath, [cli, "init", "--data-dir", "x".repeat(2_000)], { timeout: 5_000 }));
    refused(() => spawnSync(process.execPath, [cli, "init", "--data-dir", "x".repeat(2_000), "--skip-start"], { timeout: 5_000 }));
  }, 20_000);
  test("a Bun symlink resolved through the child PATH is refused", () => {
    const { root, cli } = fixture();
    for (const name of ["runtime", "runtime\\alias"]) {
      symlinkSync(process.execPath, join(root, name));
      refused(() => spawnSync(name, [cli, "init"], { timeout: 5_000, cwd: dirname(root), env: { PATH: root } }));
    }
  }, 20_000);
  for (const context of ["environment", "working directory"]) {
    test(`a launcher selecting Bun for the child ${context} is refused`, () => {
      const parentOnly = "FLAIR_GUARD_PARENT_ONLY";
      if (!process.env[parentOnly]) {
        const result = spawnSync(process.execPath, ["test", import.meta.filename,
          "--test-name-pattern", `a launcher selecting Bun for the child ${context} is refused`], {
          env: { ...process.env, [parentOnly]: "1" }, encoding: "utf8", timeout: 15_000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("1 pass");
        return;
      }
      const { root, cli } = fixture();
      const runtime = join(root, "runtime");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const env = { ...process.env };
      delete env[parentOnly];
      const condition = context === "environment" ? `[ "$${parentOnly}" = 1 ]` : `[ "$PWD" != ${quote(root)} ]`;
      writeFileSync(runtime, `#!/bin/sh\nif ${condition}; then exec ${quote(Bun.which("node")!)} "$@"; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
      expect(spawnSync(runtime, ["-p", "process.versions.bun ? 'bun' : 'node'"], {
        encoding: "utf8", timeout: 5_000,
      }).stdout.trim()).toBe("node");
      const options = { env, cwd: root, timeout: 5_000 };
      expect(spawnSync("./runtime", ["-p", "process.versions.bun ? 'bun' : 'node'"], {
        ...options, encoding: "utf8",
      }).stdout.trim()).toBe("bun");
      for (const args of [[cli, "init"], [harperEntry, "run", "."]]) {
        refused(() => spawnSync("./runtime", args, options));
        refused(() => Bun.spawnSync(["./runtime", ...args], options), "Bun.spawnSync");
      }
    }, 20_000);
  }
  test("nodeBin and the guard refuse a launcher that probes with Node and dispatches CLI and Harper to Bun", () => {
    const { root, cli } = fixture();
    const runtime = join(root, "runtime");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(runtime, `#!/bin/sh\nif [ "$1" = "-p" ]; then exec ${quote(Bun.which("node")!)} "$@"; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    writeFileSync(cli, "console.log(process.versions.bun ? 'bun' : 'node')");
    expect(execFileSync(runtime, ["-p", "process.versions.bun ? 'bun' : 'node'"], {
      encoding: "utf8", timeout: 5_000,
    }).trim()).toBe("node");
    expect(() => nodeBin({ env: { ...process.env, NODE_BIN: runtime } })).toThrow("cannot verify direct Node executable");
    const options = { encoding: "utf8" as const, timeout: 5_000 };
    for (const args of [[cli, "init"], [harperEntry, "run", "."]]) {
      refused(() => spawnSync(runtime, args, options), "child_process.spawnSync", "TestRuntimeIdentityError");
      refused(() => Bun.spawnSync([runtime, ...args], options), "Bun.spawnSync", "TestRuntimeIdentityError");
      refused(() => spawnSync(runtime, args, { ...options,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: " " },
      }), "child_process.spawnSync", "TestRuntimeIdentityError");
    }
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = spawnSync(runtime, [cli, "init"], { ...options, timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise argument-dependent launcher" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("bun");
      expect(log.mock.calls.flat().join("\n")).toContain("exercise argument-dependent launcher");
    } finally { log.mockRestore(); }
  }, 20_000);
  test("a renamed Bun executable is refused", () => {
    const { root, cli } = fixture();
    const runtime = join(root, "runtime");
    copyFileSync(process.execPath, runtime);
    refused(() => spawnSync(runtime, [cli, "init"], { timeout: 5_000 }));
  }, 20_000);
  test("an unverifiable runtime requires a child-only reason", () => {
    const { root, cli } = fixture();
    const runtime = join(root, "runtime");
    const bun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    writeFileSync(runtime, `#!/bin/sh\nif [ "$1" = "-p" ]; then exit 1; fi\nexec ${bun} "$@"\n`, { mode: 0o755 });
    refused(() => spawnSync(runtime, [cli, "init"], { timeout: 5_000 }), "child_process.spawnSync", "TestRuntimeIdentityError");
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = spawnSync(runtime, [cli, "init"], { encoding: "utf8", timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "wrapper fixture delegates to Bun" } });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["init"]);
      expect(log.mock.calls.flat().join("\n")).toContain("wrapper fixture delegates to Bun");
    } finally { log.mockRestore(); }
  }, 20_000);
  test("a temporary harper.js stub is allowed under Bun", () => {
    allowed(join(fixture().root, "harper.js"), ["run", "."]);
  }, 20_000);
  test("the installed Harper entry is refused under Bun", () => {
    refused(() => spawnSync(process.execPath, [harperEntry, "run", "."], { timeout: 5_000 }));
  }, 20_000);
  test("an argument-printing script standing in for the packaged shim is refused", () => {
    const { root } = fixture();
    refused(() => spawnSync(process.execPath, [join(root, "dist", "cli-shim.cjs"), "init"], { timeout: 5_000 }));
  }, 20_000);
  for (const command of ["start", "restart", "upgrade"]) {
    test(`${command} is refused`, () => {
      const { cli } = fixture();
      refused(() => spawnSync(process.execPath, [cli, command], { timeout: 5_000 }));
    }, 20_000);
  }
  test("doctor --fix is refused for an argument-printing script standing in for the CLI entry", () => {
    const { cli } = fixture();
    refused(() => spawnSync(process.execPath, [cli, "doctor", "--fix"], { timeout: 5_000 }));
  }, 20_000);
  for (const args of [["snapshot", "create"], ["snapshot", "restore", "backup.tgz"], ["upgrade", "--no-restart"], ["--", "init"]]) {
    test(`${args.join(" ")} is refused`, () => {
      refused(() => spawnSync(process.execPath, [fixture().cli, ...args], { timeout: 5_000 }));
    }, 20_000);
  }
  test("an argument-printing script standing in for a source entry may receive init", () => {
    allowed(join(fixture().root, "source-cli.js"), ["init"]);
  }, 20_000);
  test("Node running an argument-printing script standing in for the shipped entry is allowed", () => {
    const { cli } = fixture();
    const result = spawnSync(Bun.which("node")!, [cli, "init"], { encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["init"]);
  }, 20_000);
  for (const args of [
    ["status"], ["doctor"], ["doctor", "--fix", "--dry-run"],
    ["init", "--skip-start"], ["init", "--target", "https://example.invalid"],
    ["init", "--target=https://example.invalid"], ["init", "--help"], ["start", "-h"],
    ["upgrade", "--check"], ["snapshot", "list"],
    ["upgrade", "--target", "https://example.invalid"],
  ]) {
    test(`a Bun spawn of an argument-printing CLI fixture running ${args.join(" ")} is refused`, () => {
      refused(() => spawnSync(process.execPath, [fixture().cli, ...args], { timeout: 5_000 }));
    }, 10_000);
  }
  test("the narrower CLI rule is the runtime, not the subcommand", () => {
    const { cli } = fixture();
    refused(() => spawnSync(process.execPath, [cli, "doctor"], { timeout: 5_000 }));
    const result = spawnSync(Bun.which("node")!, [cli, "doctor"], { encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["doctor"]);
  }, 20_000);
  test("an init-only flag does not exempt start", () => {
    refused(() => spawnSync(process.execPath, [fixture().cli, "start", "--skip-start"], { timeout: 5_000 }));
  }, 20_000);
  test("a child-only reason permits and logs an otherwise forbidden spawn", () => {
    const { cli } = fixture();
    const previous = process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
    delete process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const options = {
        encoding: "utf8" as const, timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise this guard's opt-out" },
      };
      const command = `UNUSED=value bun '${cli}' init`;
      const results = [
        spawnSync(process.execPath, [cli, "init"], { ...options, timeout: 5_000 }),
        spawnSync("/usr/bin/env", ["-u", "UNUSED", "OTHER=value", "bun", cli, "init"], { ...options, timeout: 5_000 }),
        spawnSync(command, { ...options, shell: true, timeout: 5_000 }),
        spawnSync("/bin/sh", ["-c", command], { ...options, timeout: 5_000 }),
        spawnSync("/bin/bash", ["-c", command], { ...options, timeout: 5_000 }),
      ];
      for (const result of results) {
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["init"]);
      }
      expect(log.mock.calls.flat().join("\n")).toContain("exercise this guard's opt-out");
      expect(log.mock.calls.flat().join("\n")).toContain("cli-runtime-node-guard-2570.test.ts:");
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
      else process.env.FLAIR_TEST_ALLOW_BUN_HARPER = previous;
    }
  }, 40_000);
  test("blank and ambient reasons do not permit a spawn", () => {
    const { cli } = fixture();
    refused(() => spawnSync(process.execPath, [cli, "init"], { timeout: 5_000, env: { FLAIR_TEST_ALLOW_BUN_HARPER: "  " } }));
    const previous = process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
    process.env.FLAIR_TEST_ALLOW_BUN_HARPER = "ambient";
    try {
      refused(() => spawnSync(process.execPath, [cli, "init"], { timeout: 5_000 }));
      refused(() => spawnSync(process.execPath, [cli, "init"], { timeout: 5_000, env: { ...process.env } }));
      refused(() => spawnSync(process.execPath, [cli, "init"], {
        timeout: 5_000, env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "different child reason" },
      }));
    }
    finally {
      if (previous === undefined) delete process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
      else process.env.FLAIR_TEST_ALLOW_BUN_HARPER = previous;
    }
  }, 30_000);
});
