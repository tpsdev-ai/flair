import { describe, expect, spyOn, test } from "bun:test";
import childProcess, { exec, execSync, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

// The installed Harper entry is a real binary, and its CLI implements `version`.
// The GNU `--version` is not a Harper subcommand: it falls through to `run`, which
// bootstraps the installer and exits 130 at its first non-interactive prompt in a
// fresh HOME (flair#2603). The fixture printers echo whatever argv they get.
function protectedArgument(entry: string): string {
  return entry === harperEntry ? "version" : "--version";
}

function allowed(cli: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5_000 });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
}

describe("Bun Harper spawn preload", () => {
  test("promisified execFile retains output fields and the child handle", async () => {
    const pending = promisify(execFile)(nodeBin(), ["-e", "console.log(42)"], { timeout: 5_000 });
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
  test("a missing executable naming a protected entry requires a reason", () => {
    const { root, cli } = fixture();
    refused(() => spawnSync(join(root, "missing"), [cli, "init"], { timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    const result = spawnSync(join(root, "missing"), [cli, "init"], { timeout: 5_000,
      env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise native missing-executable error" },
    });
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }, 20_000);
  for (const [flag, source] of [["--eval", "console.log(42)"], ["--print", "42"]]) {
    test(`${flag} receives a CLI entry argument as data with a child-only reason`, () => {
      const { cli } = fixture();
      refused(() => spawnSync(process.execPath, [flag, source, cli, "init"], { timeout: 5_000 }),
        "child_process.spawnSync", flag === "--eval" ? "TestRuntimeIdentityError" : "BunHarperSpawnError");
      const result = spawnSync(process.execPath, [flag, source, cli, "init"], {
        encoding: "utf8", timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise protected entry as eval data" },
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
      [["env", "bun", cli, "init"], "launching dist/cli.js"],
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
            "child_process.spawnSync", runtime === unknown || form.shell || form.command === "/bin/sh" ? "TestRuntimeIdentityError" : "BunHarperSpawnError");
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
      refused(() => spawnSync(command, { shell: true, timeout: 5_000 }), "child_process.spawnSync", "TestRuntimeIdentityError");
      for (const shell of ["/bin/sh", "/bin/bash"]) {
        refused(() => spawnSync(shell, ["-c", command], { timeout: 5_000 }), "child_process.spawnSync", "TestRuntimeIdentityError");
      }
    }
  }, 20_000);
  test("a compound shell command launching the built CLI under Bun requires a child-only reason", () => {
    ensureCliBuild();
    const cli = resolve(import.meta.dir, "../../dist/cli.js");
    const error = refused(() => spawnSync(`true; bun '${cli}' status`, [], { shell: true, timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    expect(error.message).toContain("unclassifiable shell string");
  }, 20_000);
  for (const shell of ["shell: true", "/bin/sh", "/bin/bash"]) {
    for (const syntax of ["glob", "command substitution", "literal Bun"]) {
      test(`${shell} requires a child-only reason for ${syntax}`, () => {
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
          "child_process.spawnSync", "TestRuntimeIdentityError");
        expect(error.message).toContain(syntax === "literal Bun" ? "launching dist/cli.js" : "unclassifiable shell string");
      }, 20_000);
    }
    test(`${shell} requires a child-only reason for unresolved shell executables`, () => {
      const { root, cli } = fixture();
      for (const executable of [join(root, "missing"), "flair-missing-runtime-2603"]) {
        for (const entry of ["", ` '${cli}' status`]) {
          const command = `'${executable}'${entry}`;
          const error = refused(() => spawnSync(shell === "shell: true" ? command : shell,
            shell === "shell: true" ? [] : [shell === "/bin/bash" ? "-ec" : "-c", command], {
              shell: shell === "shell: true", timeout: 5_000,
              env: undefined,
            }), "child_process.spawnSync", "TestRuntimeIdentityError");
          expect(error.message).toContain("unresolved shell executable");
        }
      }
    }, 20_000);
  }
  test("spawnSync classifiable shell commands without refused shell characters use the child PATH", async () => {
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
    test(`bash ${flag} requires a child-only reason for a Bun CLI fixture`, () => {
      const error = refused(() => spawnSync("/bin/bash", [flag, `'${process.execPath}' '${fixture().cli}' status`], {
        timeout: 5_000,
      }), "child_process.spawnSync", "TestRuntimeIdentityError");
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
  test("compound and ambiguous shell strings require a child-only reason", () => {
    const { cli } = fixture();
    for (const command of [
      ...[";", "&&", "||", "|", "\n", "&"].map(separator => `true ${separator} bun '${cli}' status`),
      `(bun '${cli}' status)`, `echo $(bun '${cli}' status)`,
      `echo \`bun '${cli}' status\``, `echo "$(bun '${cli}' status)"`,
      `echo "\`bun '${cli}' status\`"`, `echo $RUNTIME`,
      `/usr/bin/time sh -c "true; bun '${cli}' status"`,
      `env sh -c "true; bun '${cli}' status"`,
      "echo \\\nvalue", "echo 'unterminated",
    ]) {
      for (const shell of ["/bin/sh", "/bin/bash"]) {
        const error = refused(() => spawnSync(shell, ["-c", command], { timeout: 5_000,
        }),
          "child_process.spawnSync", "TestRuntimeIdentityError");
        expect(error.message).toContain("unclassifiable shell string");
      }
    }
  }, 20_000);
  test("spawnSync env and shell launches require a child-only reason for protected entries", () => {
    const { root, cli } = fixture();
    const node = nodeBin();
    refused(() => spawnSync("/usr/bin/env", [node, cli, "init"], { timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    const direct = spawnSync("/usr/bin/env", ["-u", "UNUSED", "OTHER=value", node, cli, "init"], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise Node through env" },
    });
    expect(direct.status).toBe(0);
    expect(JSON.parse(direct.stdout)).toEqual(["init"]);
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const entry of [cli, join(root, "dist", "cli-shim.cjs"), harperEntry]) {
        const command = `UNUSED=value '${node}' '${entry}' ${protectedArgument(entry)}`;
        for (const shell of ["shell: true", "/bin/sh", "/bin/bash"]) {
          const executable = shell === "shell: true" ? command : shell;
          const args = shell === "shell: true" ? [] : ["-c", command];
          const options = { shell: shell === "shell: true", encoding: "utf8" as const, timeout: 5_000 };
          const error = refused(() => spawnSync(executable, args, options),
            "child_process.spawnSync", "TestRuntimeIdentityError");
          expect(error.message).toContain("shell string launching");
          for (const env of [undefined, { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: " " }]) {
            refused(() => spawnSync(executable, args, { ...options, env }),
              "child_process.spawnSync", "TestRuntimeIdentityError");
          }
          const result = spawnSync(executable, args, { ...options,
            env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise protected Node entries through real shells" },
          });
          expect(result.status).toBe(0);
          if (entry !== harperEntry) expect(JSON.parse(result.stdout)).toEqual(["--version"]);
        }
      }
      expect(log.mock.calls.flat().join("\n")).toContain("exercise protected Node entries through real shells");
    } finally { log.mockRestore(); }
  }, 40_000);
  test("spawnSync shell commands naming a protected entry as the executable require a child-only reason", () => {
    const { root, cli } = fixture();
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const entry of [cli, join(root, "dist", "cli-shim.cjs"), harperEntry]) {
        if (entry !== harperEntry) {
          writeFileSync(entry, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))", { mode: 0o755 });
          chmodSync(entry, 0o755);
        }
        const alias = join(root, entry === cli ? "cli" : entry === harperEntry ? "harper" : "shim");
        symlinkSync(entry, alias);
        const argument = protectedArgument(entry);
        for (const command of [`'${entry}' ${argument}`, `${alias.split("/").at(-1)} ${argument}`]) {
          const options = { shell: true, timeout: 5_000, encoding: "utf8" as const,
            env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
          };
          refused(() => spawnSync(command, { ...options, timeout: 5_000 }), "child_process.spawnSync", "TestRuntimeIdentityError");
          const result = spawnSync(command, { ...options, timeout: 5_000,
            env: { ...options.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise shell entry executables and PATH aliases" },
          });
          expect(result.status).toBe(0);
          if (entry !== harperEntry) expect(JSON.parse(result.stdout)).toEqual(["--version"]);
        }
      }
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  }, 40_000);
  for (const wrapper of ["/usr/bin/time", "env", "nice -n 5", "xargs -I ARG", "sh -c", "env sh -c", "env env", "custom", ...(Bun.which("timeout") ? ["timeout 5"] : [])]) {
    test(`${wrapper} shell tokens naming protected entries require a child-only reason`, () => {
      const { root } = fixture();
      const custom = join(root, "wrapper");
      writeFileSync(custom, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      const prefix = wrapper === "custom" ? custom : wrapper;
      const log = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const entry of ["./dist/cli.js", "./dist/cli-shim.cjs", harperEntry]) {
          const argument = entry === "./dist/cli.js" ? wrapper === "env" || wrapper === "nice -n 5" ? "" : "status" : protectedArgument(entry);
          const inner = `bun ${entry} ${argument}`;
          const command = wrapper.endsWith("sh -c") ? `${wrapper === "sh -c" ? "/usr/bin/time sh -c" : wrapper} '${inner}'` : `${prefix} ${inner}`;
          const options = { cwd: root, shell: true, encoding: "utf8" as const, timeout: 5_000,
            input: "run\n",
          };
          const error = refused(() => spawnSync(command, { ...options, timeout: 5_000 }),
            "child_process.spawnSync", "TestRuntimeIdentityError");
          expect(error.message).toContain("shell string launching");
          const result = spawnSync(command, { ...options, timeout: 5_000,
            env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise wrapped protected entries through a real shell" },
          });
          expect(result.status, result.stderr).toBe(0);
          if (entry !== harperEntry) expect(JSON.parse(result.stdout)).toEqual(argument ? [argument] : []);
        }
        expect(log).toHaveBeenCalled();
      } finally { log.mockRestore(); }
    }, 30_000);
  }
  for (const args of [["sh", "-c", "bun ./dist/cli.js --version"], ["bun", "./dist/cli.js", "--version"]]) {
    test(`/usr/bin/time ${args.join(" ")} requires a child-only reason`, () => {
      ensureCliBuild();
      const options = { encoding: "utf8" as const, timeout: 5_000 };
      refused(() => spawnSync("/usr/bin/time", args, options), "child_process.spawnSync", "TestRuntimeIdentityError");
      const log = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = spawnSync("/usr/bin/time", args, { ...options, timeout: 5_000,
          env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise direct time wrapper under Bun" },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version);
        expect(log).toHaveBeenCalled();
      } finally { log.mockRestore(); }
    }, 20_000);
  }
  test("an unknown wrapper's unclassifiable command operand requires a child-only reason", () => {
    const { root, cli } = fixture();
    const wrapper = join(root, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec sh -c "$1"\n', { mode: 0o755 });
    const args = [`bun '${cli}' --version; true`];
    refused(() => spawnSync(wrapper, args, { timeout: 5_000 }), "child_process.spawnSync", "TestRuntimeIdentityError");
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = spawnSync(wrapper, args, { encoding: "utf8", timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise an unknown wrapper's command operand" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["--version"]);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  }, 20_000);
  test("unclassifiable nested shell tokens require a child-only reason", () => {
    ensureCliBuild();
    const args = ["sh", "-c", "$FLAIR_GUARD_RUNTIME ./dist/cli.js --version"];
    refused(() => spawnSync("/usr/bin/time", args, { timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = spawnSync("/usr/bin/time", args, { encoding: "utf8", timeout: 5_000,
        env: { ...process.env, FLAIR_GUARD_RUNTIME: "bun", FLAIR_TEST_ALLOW_BUN_HARPER: "exercise unclassifiable nested command tokens" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  }, 20_000);
  test("direct Node may receive unclassifiable shell text as CLI data without a reason", () => {
    const { cli } = fixture();
    const args = ["sh", "-c", "$UNCLASSIFIED"];
    const result = spawnSync(nodeBin(), [cli, ...args], { encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  }, 20_000);
  test("protected entries after a shell command operand require a reason", () => {
    const { cli } = fixture();
    refused(() => spawnSync("sh", ["-c", "printf ordinary", "argument-zero", cli], { timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
  }, 20_000);
  test("direct Node runs the built CLI without a reason", () => {
    ensureCliBuild();
    const result = spawnSync(nodeBin(), ["./dist/cli.js", "--version"], { encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version);
  }, 20_000);
  for (const [api, run] of Object.entries({ spawn, spawnSync, execFile, execFileSync })) {
    test(`child_process.${api} inspects direct wrapper argv and nested shell tokens`, () => {
      const { cli } = fixture();
      for (const args of [["bun", cli], ["sh", "-c", `bun '${cli}'`], ["bash", "-lc", `bun '${cli}'`]]) {
        refused(() => Reflect.apply(run, undefined, ["/usr/bin/time", args, { timeout: 5_000 }]),
          `child_process.${api}`, "TestRuntimeIdentityError");
      }
    }, 20_000);
  }
  for (const api of ["spawn", "spawnSync"] as const) {
    test(`Bun.${api} inspects direct wrapper argv and nested shell tokens`, () => {
      const { cli } = fixture();
      for (const args of [["bun", cli], ["sh", "-c", `bun '${cli}'`]]) {
        refused(() => Reflect.apply(Bun[api], Bun, [["/usr/bin/time", ...args], { timeout: 5_000 }]),
          `Bun.${api}`, "TestRuntimeIdentityError");
      }
    }, 20_000);
  }
  test("shell strings require a reason even when a protected entry is an ordinary argument", () => {
    const { cli } = fixture();
    for (const command of [`printf '%s' '${cli}'`, `env printf '%s' '${cli}'`, `nice -n 5 printf '%s' '${cli}'`]) {
      refused(() => spawnSync(command, { shell: true, timeout: 5_000 }),
        "child_process.spawnSync", "TestRuntimeIdentityError");
    }
  }, 20_000);
  test("shell strings without protected entries retain nested env refusal", () => {
    const error = refused(() => spawnSync("env sh -c 'printf ordinary'", { shell: true, timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    expect(error.message).toContain("unsupported nested env wrapper");
  }, 20_000);
  test("spawnSync with a real Bash exported node function requires a child-only reason for the built CLI", () => {
    ensureCliBuild();
    const marker = join(tempDir("flair-bash-runtime-"), "runtime.cjs");
    writeFileSync(marker, "console.error('Bash function runtime: ' + (process.versions.bun ? 'bun' : 'node'))");
    const env = {
      ...process.env,
      "BASH_FUNC_node%%": `() { '${process.execPath}' --preload '${marker}' "$@"; }`,
    };
    const options = { cwd: resolve(import.meta.dir, "../.."), env, encoding: "utf8" as const, timeout: 5_000 };
    const error = refused(() => spawnSync("/bin/bash", ["-c", "node ./dist/cli.js --version"], { ...options, timeout: 5_000 }),
      "child_process.spawnSync", "TestRuntimeIdentityError");
    expect(error.message).toContain("shell string launching dist/cli.js");
    const log = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = spawnSync("/bin/bash", ["-c", "node ./dist/cli.js --version"], { ...options,
        timeout: 5_000,
        env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise Bash exported node function dispatching to Bun" },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Bash function runtime: bun");
      expect(result.stdout.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version);
      expect(log.mock.calls.flat().join("\n")).toContain("exercise Bash exported node function dispatching to Bun");
    } finally { log.mockRestore(); }
    expect(process.env["BASH_FUNC_node%%"]).toBeUndefined();
  }, 20_000);
  for (const api of ["exec", "execSync"] as const) {
    test(`child_process.${api} guards shell strings independently of Bun.spawn and Bun.spawnSync`, () => {
      ensureCliBuild();
      const source = `
        const rawSpawn = Bun.spawn;
        const rawSpawnSync = Bun.spawnSync;
        await import(${JSON.stringify(resolve(import.meta.dir, "../helpers/bun-harper-spawn-guard.ts"))});
        Bun.spawn = rawSpawn;
        Bun.spawnSync = rawSpawnSync;
        const { ${api}: run } = await import("node:child_process");
        let error;
        try { run("bun ./dist/cli.js --version", { timeout: 5000 }); }
        catch (caught) { error = caught; }
        if (error?.name !== "TestRuntimeIdentityError" || !error.message.includes("child_process.${api}")) {
          throw new Error("${api} did not refuse the protected entry before invoking Bun.spawn/Bun.spawnSync");
        }
        console.log("${api} refused at its own boundary");
      `;
      const output = execFileSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 10_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise exec guards inside a Bun evaluation child" },
      });
      expect(output.trim()).toBe(`${api} refused at its own boundary`);
    }, 20_000);
    test(`child_process.${api} refuses bun ./dist/cli.js --version without a child-only reason`, () => {
      ensureCliBuild();
      const command = "bun ./dist/cli.js --version";
      for (const fn of [childProcess[api], cjs[api], api === "exec" ? exec : execSync]) {
        for (const env of [undefined, { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: " " }]) {
          const error = refused(() => fn(command, { env, timeout: 5_000 }),
            `child_process.${api}`, "TestRuntimeIdentityError");
          expect(error.message).toContain("shell string launching dist/cli.js");
        }
      }
      const previous = process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
      process.env.FLAIR_TEST_ALLOW_BUN_HARPER = "ambient reason";
      try {
        refused(() => childProcess[api](command, { timeout: 5_000,
          env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "child reason" },
        }), `child_process.${api}`, "TestRuntimeIdentityError");
      } finally {
        if (previous === undefined) delete process.env.FLAIR_TEST_ALLOW_BUN_HARPER;
        else process.env.FLAIR_TEST_ALLOW_BUN_HARPER = previous;
      }
    }, 20_000);
    test(`child_process.${api} runs bun ./dist/cli.js --version with a child-only reason`, async () => {
      ensureCliBuild();
      const options = { encoding: "utf8" as const, timeout: 5_000,
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: `exercise ${api} built CLI under Bun` },
      };
      const log = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const command = "bun ./dist/cli.js --version";
        const output = api === "execSync" ? execSync(command, options)
          : await new Promise<string>((resolve, reject) => {
            exec(command, options, (error, stdout) => error ? reject(error) : resolve(stdout));
          });
        expect(output.trim()).toBe(JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version);
        expect(log.mock.calls.flat().join("\n")).toContain(`exercise ${api} built CLI under Bun`);
      } finally { log.mockRestore(); }
    }, 20_000);
    test(`child_process.${api} refuses compound syntax without a child-only reason`, () => {
      const error = refused(() => childProcess[api]("true; bun ./dist/cli.js --version", { timeout: 5_000,
      }), `child_process.${api}`, "TestRuntimeIdentityError");
      expect(error.message).toContain("unclassifiable shell string");
    }, 20_000);
  }
  test("promisified exec refuses a protected shell string and retains ordinary output and the child handle", async () => {
    await expect(promisify(exec)("bun ./dist/cli.js --version", { timeout: 5_000 })).rejects.toMatchObject({
      name: "TestRuntimeIdentityError", message: expect.stringContaining("child_process.exec"),
    });
    const pending = promisify(exec)("printf ordinary", { timeout: 5_000 });
    expect(pending.child.pid).toBeGreaterThan(0);
    expect(await pending).toEqual({ stdout: "ordinary", stderr: "" });
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
  test("a runtime option value naming the installed Harper entry requires a child-only reason", () => {
    const { root } = fixture();
    refused(() => spawnSync(process.execPath, ["--title", harperEntry, join(root, "source-cli.js"), "init"], { timeout: 5_000 }));
    const result = spawnSync(process.execPath, ["--title", harperEntry, join(root, "source-cli.js"), "init"], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise protected entry as runtime option data" },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["init"]);
  }, 20_000);
  test("a source-entry script receives a Harper path as data with a child-only reason", () => {
    const { root } = fixture();
    const data = [harperEntry, "run", "."];
    refused(() => spawnSync(process.execPath, ["--smol", join(root, "source-cli.js"), ...data], { timeout: 5_000 }));
    const result = spawnSync(process.execPath, ["--smol", join(root, "source-cli.js"), ...data], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise protected entry as source-script data" },
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
        env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "probe the context-dependent runtime with JavaScript data" },
      }).stdout.trim()).toBe("node");
      const options = { env, cwd: root, timeout: 5_000 };
      expect(spawnSync("./runtime", ["-p", "process.versions.bun ? 'bun' : 'node'"], {
        ...options, encoding: "utf8",
        env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "probe the context-dependent runtime with JavaScript data" },
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
      env: { ...process.env, FLAIR_TEST_ALLOW_BUN_HARPER: "probe the argument-dependent runtime with JavaScript data" },
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
  test("subcommands do not exempt a protected Bun launch", () => {
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
