import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const childProcess = createRequire(import.meta.url)("node:child_process");
const probe = Bun.spawnSync.bind(Bun);
const which = Bun.which.bind(Bun);
const ALLOW = "FLAIR_TEST_ALLOW_BUN_HARPER";
const repositoryRequire = createRequire(new URL("../../package.json", import.meta.url));
const harper = resolveHarperEntry();
const harperEntry = harper.canonical;
type Options = { cwd?: string | URL; env?: Record<string, string | undefined>; shell?: boolean | string };

function resolveHarperEntry(): { canonical: string; suffix: string } {
  for (const name of ["harper", "@harperfast/harper"]) {
    let entry: string;
    try { entry = repositoryRequire.resolve(name); } catch { continue; }
    for (let dir = dirname(entry);; dir = dirname(dir)) {
      const manifest = resolve(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === name) {
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.harper;
          if (typeof bin !== "string") throw new Error(`${name} has no Harper bin`);
          return { canonical: realpathSync(resolve(dir, bin)), suffix: `node_modules/${name}/${bin.replace(/^\.\//, "")}` };
        }
      }
      if (dirname(dir) === dir) break;
    }
  }
  throw new Error("Cannot resolve the installed Harper entry from the repository");
}

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
  let executable: string | null;
  try { executable = which(command, {
    cwd: cwdPath(options.cwd),
    PATH: options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
  }); } catch { return; }
  if (executable) return canonicalPath(executable);
}

function runtimeKind(command: string, options: Options): "bun" | "node" | "unknown" | "missing" {
  const executable = resolvedExecutable(command, options);
  if (!executable) return "missing";
  if (executable === canonicalPath(process.execPath)) return process.versions.bun ? "bun" : "node";
  if (entryKind(executable, options)) return "unknown";
  try {
    const evaluate = (expression: string) => {
      const result = probe([executable, "-p", expression], {
        env: options.env, cwd: cwdPath(options.cwd), stdin: "ignore", stdout: "pipe", stderr: "pipe",
        timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 1_024,
      });
      if (result.exitCode !== 0) throw new Error("runtime probe failed");
      return result.stdout.toString().trim();
    };
    const identity = evaluate("process.versions.bun ? 'bun' : process.versions.node");
    if (identity === "bun") return "bun";
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(identity)) return "unknown";
    return realpathSync(evaluate("process.execPath")) === executable ? "node" : "unknown";
  } catch { return "unknown"; }
}

type EntryKind = "harper.js" | "dist/cli.js" | "dist/cli-shim.cjs";

function entryKind(arg: string, options: Options): EntryKind | undefined {
  const entry = resolve(cwdPath(options.cwd), arg);
  const canonical = canonicalPath(entry);
  if (canonical === harperEntry) return "harper.js";
  for (const path of [entry, canonical].map(value => value.replaceAll(sep, "/"))) {
    if (/\/dist\/(cli\.js|cli-shim\.cjs)$/.test(path)) return basename(path) === "cli.js" ? "dist/cli.js" : "dist/cli-shim.cjs";
  }
}

function commandWords(source: string, shell: boolean): string[] | undefined {
  // Shell expansion characters cannot be classified, including when quoted or escaped.
  if (shell ? /[*?\[\]$`{}~]/.test(source) : /\$\{/.test(source)) return;
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\" && quote !== "'") {
      if (++i === source.length) return;
      if (source[i] === "\n") return;
      word += source[i]; started = true;
    }
    else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (shell && /[;&|<>()\n]/.test(char)) return;
    else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else { word += char; started = true; }
  }
  if (quote) return;
  if (started) words.push(word);
  return words;
}

const shells = new Set(["sh", "bash", "zsh", "dash"]);

function shellCommandIndex(words: string[]): number {
  if (!shells.has(basename(words[0] ?? ""))) return -1;
  for (let i = 1; /^[+-]/.test(words[i] ?? "") && words[i] !== "--"; i++) {
    if (/^-[^-]*c/.test(words[i])) return i + 1;
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file", "--emulate"].includes(words[i])) i++;
  }
  return -1;
}

function argvEntry(words: string[], options: Options): EntryKind | undefined {
  let found: EntryKind | undefined;
  for (const word of words) {
    found ??= (word.includes("/") || word.startsWith(".") ? entryKind(word, options) : undefined)
      ?? (word.includes("dist/cli-shim.cjs") ? "dist/cli-shim.cjs"
        : word.includes("dist/cli.js") ? "dist/cli.js"
        : word.includes(harperEntry) || word.split(/[\s'"]/).some(part =>
          part.includes(harper.suffix) && entryKind(part, options) === "harper.js") ? "harper.js" : undefined);
  }
  return found;
}

function shellEntry(words: string[], options: Options, uncertainty = { value: false }, shellSource = false): EntryKind | undefined {
  let found = argvEntry(words, options);
  const chain = [...words];
  if (shellSource) while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(chain[0] ?? "")) chain.shift();
  while (chain.length) {
    const executable = resolvedExecutable(chain[0], options);
    if (executable) found ??= entryKind(executable, options);
    const commandIndex = shellCommandIndex(chain);
    if (commandIndex >= 0) {
      const nested = commandWords(chain[commandIndex] ?? "", true);
      if (!nested) uncertainty.value = true;
      else {
        const entry = shellEntry(nested, options, uncertainty, true);
        found ??= entry;
      }
      break;
    }
    const wrapper = basename(chain.shift()!);
    if (!["env", "time", "nice", "xargs", "nohup", "timeout", "stdbuf", "setsid", "command", "exec"].includes(wrapper)) break;
    while (chain.length) {
      const word = chain[0];
      if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { chain.shift(); continue; }
      if (word === "--") { chain.shift(); break; }
      if (!word.startsWith("-")) break;
      chain.shift();
      if (wrapper === "env" && (word === "-S" || word === "--split-string" || word.startsWith("--split-string=") || word.startsWith("-S"))) {
        const source = word.startsWith("--split-string=") ? word.slice(15)
          : word.startsWith("-S") && word !== "-S" ? word.slice(2) : chain.shift();
        const split = source === undefined ? undefined : commandWords(source, false);
        if (!split) { uncertainty.value = true; break; }
        chain.unshift(...split);
      } else {
        const operands: Record<string, string[]> = {
          env: ["-u", "--unset", "-C", "--chdir"],
          time: ["-f", "--format", "-o", "--output"],
          nice: ["-n", "--adjustment"],
          xargs: ["-E", "-I", "-J", "-L", "-n", "-P", "-s", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"],
          timeout: ["-s", "--signal", "-k", "--kill-after"],
          stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
        };
        if (operands[wrapper]?.includes(word)) chain.shift();
      }
    }
    if (wrapper === "timeout") chain.shift();
  }
  return found;
}

function invocation(command: string, args: string[], options: Options) {
  let words: string[] | undefined = [command, ...args];
  const commandIndex = shellCommandIndex(words);
  const shellString = !!options.shell || commandIndex >= 0;
  if (options.shell) words = commandWords(words.join(" "), true);
  else if (commandIndex >= 0) {
    words = commandWords(words[commandIndex] ?? "", true);
  }
  const probeOptions = { ...options, env: { ...(options.env ?? process.env) } };
  const assignment = (word: string): boolean => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (!match) return false;
    probeOptions.env[match[1]] = match[2];
    return true;
  };
  const failure = (reason: string) => ({
    command: options.shell ? typeof options.shell === "string" ? options.shell : "sh" : command,
    args: [], options: probeOptions, shellString, entry: undefined, failure: reason,
  });
  if (!words) return failure("unclassifiable shell string");
  const uncertainty = { value: false };
  const originalEntry = options.shell ? argvEntry([command, ...args], probeOptions)
    : shellEntry([command, ...args], probeOptions, uncertainty);
  const parsedEntry = shellEntry(words, probeOptions, uncertainty, shellString);
  const protectedEntry = originalEntry ?? parsedEntry;
  while (words.length && assignment(words[0])) words.shift();
  if (basename(words[0] ?? "") === "env") {
    words.shift();
    let acceptsOptions = true;
    while (words.length) {
      const word = words[0];
      if (acceptsOptions && word === "--") { words.shift(); acceptsOptions = false; continue; }
      if (assignment(word)) { words.shift(); continue; }
      if (!acceptsOptions || !word.startsWith("-")) break;
      words.shift();
      if (word === "-S" || word === "--split-string" || word.startsWith("--split-string=") || word.startsWith("-S")) {
        const source = word.startsWith("--split-string=") ? word.slice(15)
          : word.startsWith("-S") && word !== "-S" ? word.slice(2) : words.shift();
        if (source === undefined) return failure("missing env split string");
        const split = commandWords(source, false);
        if (!split?.length) return failure("unclassifiable env split string");
        words.unshift(...split);
      } else if (["-i", "--ignore-environment", "-"].includes(word)) probeOptions.env = {};
      else if (["-u", "--unset", "-C", "--chdir"].includes(word)) {
        const value = words.shift();
        if (value === undefined) return failure("missing env option operand");
        if (word === "-u" || word === "--unset") delete probeOptions.env[value];
        else probeOptions.cwd = resolve(cwdPath(probeOptions.cwd), value);
      } else if (word.startsWith("--unset=")) delete probeOptions.env[word.slice(8)];
      else if (word.startsWith("--chdir=")) probeOptions.cwd = resolve(cwdPath(probeOptions.cwd), word.slice(8));
      else return failure("unsupported env option");
    }
    if (!words[0]) return failure("missing env executable");
    if (!protectedEntry && ["env", ...shells].includes(basename(words[0]))) return failure("unsupported nested env wrapper");
    if (!resolvedExecutable(words[0], probeOptions)) return failure("unresolved env executable");
  }
  if (shellString && (!words[0] || !resolvedExecutable(words[0], probeOptions))) {
    return failure("unresolved shell executable");
  }
  return { command: words[0], args: words.slice(1), options: probeOptions, shellString,
    entry: protectedEntry ?? shellEntry(words, probeOptions),
    failure: uncertainty.value ? "unclassifiable shell string" : undefined };
}

export class BunHarperSpawnError extends Error {
  constructor(api: string, executable: string, entry: EntryKind) {
    super(`${api} refused ${basename(executable)} launching ${entry} under Bun`);
    this.name = "BunHarperSpawnError";
  }
}

export class TestRuntimeIdentityError extends Error {
  constructor(api: string, executable: string, reason: string) {
    super(`${api} refused ${basename(executable)}: ${reason}`);
    this.name = "TestRuntimeIdentityError";
  }
}

// Test-harness guard against accidental Bun launches, not a security boundary.
// It does not model hostile process environments.
// Wrapped APIs: child_process spawn, spawnSync, execFile, execFileSync, exec, execSync; Bun.spawn and Bun.spawnSync.
// Direct executables classified as Node may launch protected entries without a reason; direct Bun launches of protected entries are refused without one.
// Other launches with a protected entry path or executable require a nonempty, child-only FLAIR_TEST_ALLOW_BUN_HARPER reason.
// PATH lookup applies only to command and wrapper executables, including shell command words.
// Other argv uses protected-entry substrings and cwd-relative path resolution for words containing / or starting with .
// A shell command string in a wrapper chain fails closed when it cannot be classified or reaches a protected entry.
export function checkTestSpawn(api: string, command: unknown, args: unknown, options: Options = {}): void {
  if (typeof command !== "string" || !Array.isArray(args)) return;
  const uncertainty = { value: false };
  const originalEntry = options.shell ? argvEntry([command, ...args], options)
    : shellEntry([command, ...args], options, uncertainty);
  const scanOptions = { ...options };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1]) scanOptions.cwd = resolve(cwdPath(scanOptions.cwd), args[++i]);
    else if (args[i].startsWith("--cwd=")) scanOptions.cwd = resolve(cwdPath(scanOptions.cwd), args[i].slice(6));
  }
  const launch = invocation(command, args, scanOptions);
  launch.entry ??= originalEntry;
  launch.failure ??= uncertainty.value ? "unclassifiable shell string" : undefined;
  if (!launch.failure && !launch.entry) return;
  const reason = !Object.hasOwn(process.env, ALLOW) && options.env && Object.hasOwn(options.env, ALLOW)
    ? options.env[ALLOW]?.trim() : undefined;
  const displayCommand = options.shell ? typeof options.shell === "string" ? options.shell : "sh" : command;
  if (reason) {
    const error = new TestRuntimeIdentityError(api, displayCommand, launch.failure ?? `launching ${launch.entry}`);
    console.warn(`${error.stack}\n${ALLOW}: ${reason}`);
    return;
  }
  const runtime = options.shell ? "unknown" : runtimeKind(command, options);
  if (runtime === "node") return;
  const diagnosticRuntime = launch.shellString || launch.failure ? "unknown"
    : launch.command === command ? runtime : runtimeKind(launch.command!, launch.options);
  const error = launch.failure ? new TestRuntimeIdentityError(api, displayCommand, launch.failure)
    : diagnosticRuntime === "bun" ? new BunHarperSpawnError(api, displayCommand, launch.entry!)
    : new TestRuntimeIdentityError(api, displayCommand, `${launch.shellString ? "shell string" : "unverified runtime"} launching ${launch.entry}`);
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
      if (cmd) checkTestSpawn(api, cmd[0], cmd.slice(1), options);
    } else {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      const options = (Array.isArray(args[1]) ? args[2] : args[1]) as Options | undefined;
      const childOptions = options && typeof options === "object" ? options : {};
      checkTestSpawn(api, args[0], argv, key === "exec" || key === "execSync" ? { ...childOptions, shell: true } : childOptions);
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

for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) wrap(childProcess, api, `child_process.${api}`, false);
syncBuiltinESMExports();
const named = await import("node:child_process");
for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const) {
  if (named[api] !== childProcess[api]) throw new Error(`Cannot wrap child_process.${api}: named export did not update`);
}
for (const api of ["spawn", "spawnSync"]) wrap(Bun as unknown as Record<string, unknown>, api, `Bun.${api}`, true);
