import { readlinkSync, realpathSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const childProcess = createRequire(import.meta.url)("node:child_process");
const probe = childProcess.execFileSync;
const which = Bun.which.bind(Bun);
const ALLOW = "FLAIR_TEST_ALLOW_BUN_HARPER";
type Options = { cwd?: string | URL; env?: Record<string, string | undefined> };

function cwdPath(cwd: Options["cwd"]): string {
  return cwd instanceof URL ? fileURLToPath(cwd) : cwd ?? process.cwd();
}

function canonicalPath(path: string): string {
  for (let links = 0; links < 40; links++) {
    try { return realpathSync(path); } catch {}
    try { path = resolve(dirname(path), readlinkSync(path)); } catch { return path; }
  }
  return path;
}

function resolvedExecutable(command: string, options: Options): string | undefined {
  const executable = which(command, {
    cwd: cwdPath(options.cwd),
    PATH: (options.env ? options.env.PATH : process.env.PATH) ?? "/usr/bin:/bin",
  });
  if (executable) return canonicalPath(executable);
}

function runtimeKind(command: string, options: Options): "bun" | "node" | "unknown" | "missing" {
  const executable = resolvedExecutable(command, options);
  if (!executable) return "missing";
  if (executable === canonicalPath(process.execPath)) return process.versions.bun ? "bun" : "node";
  try {
    const identity = probe(executable, ["-p", "process.versions.bun ? 'bun' : process.versions.node"], {
      encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (identity === "bun") return "bun";
    return /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(identity) ? "node" : "unknown";
  } catch { return "unknown"; }
}

function entryKind(arg: string, options: Options): "harper" | "cli" | undefined {
  const entry = resolve(cwdPath(options.cwd), arg);
  const canonical = canonicalPath(entry);
  for (const path of [entry, canonical].map(value => value.replaceAll(sep, "/"))) {
    if (basename(path) === "harper.js") return "harper";
    if (/\/dist\/(cli\.js|cli-shim\.cjs)$/.test(path)) return "cli";
  }
}

function scriptIndex(args: string[], options: Options): number {
  const valueFlags = new Set([
    "-r", "--require", "--preload", "--import", "--loader", "--experimental-loader", "--env-file",
    "-c", "--config", "--conditions", "--port", "--fetch-preconnect", "--max-http-header-size",
    "--dns-result-order", "--title", "--unhandled-rejections", "--console-depth", "--user-agent",
    "--elide-lines", "-F", "--filter", "--shell", "--cpu-prof-name", "--cpu-prof-dir",
    "--cpu-prof-interval", "--heap-prof-name", "--heap-prof-dir", "--install",
  ]);
  const booleanFlags = new Set([
    "--watch", "--hot", "--no-clear-screen", "--smol", "--cpu-prof", "--cpu-prof-md", "--heap-prof",
    "--heap-prof-md", "--if-present", "--no-install", "-i", "--prefer-offline", "--prefer-latest",
    "--expose-gc", "--no-deprecation", "--throw-deprecation", "--zero-fill-buffers", "--use-system-ca",
    "--use-openssl-ca", "--use-bundled-ca", "--redis-preconnect", "--sql-preconnect", "--no-addons",
    "--silent", "-v", "--version", "--revision", "-b", "--bun", "--workspaces", "--parallel",
    "--sequential", "--no-exit-on-error", "--no-env-file", "-h", "--help",
  ]);
  let uncertain = false;
  const initialCwd = cwdPath(options.cwd);
  for (let i = 0; i < args.length; i++) {
    if (!uncertain && /^(?:--(?:eval|print)(?:=|$)|-[ep])/.test(args[i])) return -1;
    if (args[i] === "--cwd" && args[i + 1]) {
      options.cwd = resolve(initialCwd, args[++i]);
      continue;
    }
    if (args[i].startsWith("--cwd=")) {
      options.cwd = resolve(initialCwd, args[i].slice(6));
      continue;
    }
    if (valueFlags.has(args[i])) { i++; continue; }
    if (args[i] === "--") return i + 1;
    if (args[i] === "run") continue;
    if (args[i].startsWith("-")) {
      if (!booleanFlags.has(args[i]) && !args[i].includes("=")) uncertain = true;
      continue;
    }
    if (!uncertain || entryKind(args[i], options)) return i;
  }
  return -1;
}

function startsHarper(args: string[], options: Options): boolean {
  options = { ...options };
  const index = scriptIndex(args, options);
  if (index < 0 || !args[index]) return false;
  const kind = entryKind(args[index], options);
  if (kind === "harper") return true;
  if (kind !== "cli") return false;
  const cli = args.slice(index + 1);
  if (cli[0] === "--") cli.shift();
  const command = cli[0];
  if (cli.includes("--help") || cli.includes("-h")) return false;
  const hasValue = (flag: string): boolean => cli.some((arg, i) =>
    arg.startsWith(`${flag}=`) ? arg.length > flag.length + 1 : arg === flag && !!cli[i + 1] && !cli[i + 1].startsWith("-"));
  if (command === "init") return !cli.includes("--skip-start") && !hasValue("--target");
  if (command === "upgrade") return !cli.includes("--check") && !hasValue("--target");
  if (command === "doctor") return cli.includes("--fix") && !cli.includes("--dry-run");
  if (command === "snapshot") return ["create", "restore"].includes(cli[1]);
  return ["start", "restart", "serve", "downgrade"].includes(command);
}

export class BunHarperSpawnError extends Error {
  constructor(api: string, command: string, args: string[]) {
    super(`${api} refused Bun starting the shipped CLI/Harper: ${JSON.stringify([command, ...args])}`);
    this.name = "BunHarperSpawnError";
  }
}

export class TestRuntimeIdentityError extends Error {
  constructor(api: string, command: string) {
    super(`${api} cannot verify runtime identity for CLI/Harper child ${JSON.stringify(command)}`);
    this.name = "TestRuntimeIdentityError";
  }
}

function check(api: string, command: unknown, args: unknown, options: Options = {}): void {
  if (typeof command !== "string" || !Array.isArray(args)) return;
  if (!startsHarper(args, options)) return;
  const runtime = runtimeKind(command, options);
  if (runtime === "node" || runtime === "missing") return;
  const error = runtime === "bun" ? new BunHarperSpawnError(api, command, args) : new TestRuntimeIdentityError(api, command);
  const reason = options.env && Object.hasOwn(options.env, ALLOW) ? options.env[ALLOW]?.trim() : undefined;
  if (reason) {
    console.warn(`${error.stack}\n${ALLOW}: ${reason}`);
    return;
  }
  throw error;
}

function wrap(target: Record<string, unknown>, key: string, api: string, bun: boolean): void {
  const original = target[key];
  if (typeof original !== "function") throw new Error(`Cannot wrap ${api}: not a function`);
  const enforce = (args: unknown[]) => {
    if (bun) {
      const first = args[0] as { cmd?: string[] } | string[];
      const cmd = Array.isArray(first) ? first : first?.cmd;
      const options = (Array.isArray(first) ? args[1] : first) as Options | undefined;
      if (cmd) check(api, cmd[0], cmd.slice(1), options);
    } else {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      const options = (Array.isArray(args[1]) ? args[2] : args[1]) as Options | undefined;
      check(api, args[0], argv, options && typeof options === "object" ? options : {});
    }
  };
  const guarded = function(this: unknown, ...args: unknown[]) {
    enforce(args);
    return Reflect.apply(original, this, args);
  };
  for (const property of Reflect.ownKeys(original)) {
    if (["prototype", "caller", "arguments"].includes(String(property))) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, property);
    if (!descriptor) continue;
    if (property === Symbol.for("nodejs.util.promisify.custom") && typeof descriptor.value === "function") {
      const custom = descriptor.value;
      descriptor.value = function(this: unknown, ...args: unknown[]) {
        try { enforce(args); } catch (error) { return Promise.reject(error); }
        return Reflect.apply(custom, this, args);
      };
    }
    Object.defineProperty(guarded, property, descriptor);
  }
  try { target[key] = guarded; } catch (cause) { throw new Error(`Cannot wrap ${api}: assignment failed`, { cause }); }
  if (target[key] !== guarded) throw new Error(`Cannot wrap ${api}: assignment did not replace the function`);
}

for (const api of ["spawn", "spawnSync", "execFile", "execFileSync"]) wrap(childProcess, api, `child_process.${api}`, false);
syncBuiltinESMExports();
const named = await import("node:child_process");
for (const api of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
  if (named[api] !== childProcess[api]) throw new Error(`Cannot wrap child_process.${api}: named export did not update`);
}
for (const api of ["spawn", "spawnSync"]) wrap(Bun as unknown as Record<string, unknown>, api, `Bun.${api}`, true);
