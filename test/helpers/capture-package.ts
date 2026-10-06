import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function installCapturePackage(home: string): { cwd: string; env: NodeJS.ProcessEnv; spec: string } {
  const root = resolve(import.meta.dir, "../..");
  const source = join(root, "packages/flair-mcp");
  for (const pkg of ["flair-client", "flair-mcp"]) {
    execFileSync(process.execPath, ["run", "build"], { cwd: join(root, "packages", pkg), timeout: 30_000, stdio: "pipe" });
  }
  const stage = join(home, "package");
  mkdirSync(stage, { recursive: true });
  for (const file of ["package.json", "dist", "LICENSE", "README.md"]) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(stage, file), { recursive: true });
  }
  const copied = new Set<string>();
  const copyDependency = (name: string, from: string): void => {
    if (copied.has(name)) return;
    copied.add(name);
    let search = from;
    let pkg: string;
    for (;;) {
      const candidate = join(search, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) { pkg = realpathSync(candidate); break; }
      const parent = dirname(search);
      if (parent === search) throw new Error(`missing local dependency ${name}`);
      search = parent;
    }
    if (name === "@tpsdev-ai/flair-client") pkg = join(root, "packages/flair-client");
    const destination = join(stage, "node_modules", name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(pkg, destination, { recursive: true, filter: (path) => !relative(pkg, path).split(sep).includes("node_modules") });
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency, pkg);
  };
  const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies)) copyDependency(name, source);
  manifest.bundledDependencies = Object.keys(manifest.dependencies);
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest));
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:FLAIR|HARPER|HDB|FABRIC)_/.test(name)),
  );
  Object.assign(env, { HOME: home, USERPROFILE: home, npm_config_cache: join(home, "npm-cache"), npm_config_offline: "true" });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], {
    cwd: stage, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  }));
  const cwd = join(home, "installed");
  mkdirSync(cwd);
  execFileSync("npm", ["install", "--prefix", cwd, "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", join(home, packed[0].filename)], {
    env, timeout: 30_000, stdio: "pipe",
  });
  return { cwd, env, spec: `${manifest.name}@${manifest.version}` };
}
