import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

interface FileMtime {
  path: string;
  mtimeMs: number;
  directory: boolean;
}

function entriesUnder(path: string): FileMtime[] {
  const st = statSync(path);
  const entry = { path, mtimeMs: st.mtimeMs, directory: st.isDirectory() };
  if (entry.directory) {
    return [entry, ...readdirSync(path).flatMap((name) => entriesUnder(join(path, name)))];
  }
  readFileSync(path);
  return [entry];
}

function resourceBuild(root: string): { inputs: string[]; config: ts.ParsedCommandLine } {
  const configs = new Set<string>();
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    getCurrentDirectory: () => root,
    readFile: (path) => {
      configs.add(path);
      return readFileSync(path, "utf-8");
    },
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config || config.errors.length) {
    throw new Error(config?.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n") || "could not parse tsconfig.json");
  }
  return {
    config,
    inputs: [
      join(root, "resources"),
      join(root, "src"), // Resources import src/ modules emitted into dist/src/ for runtime.
      ...configs,
      join(root, "package.json"),
      join(root, "bun.lock"),
      join(root, "scripts", "write-build-info.mjs"),
      join(root, "scripts", "vendor-tool-descriptors.mjs"),
      join(root, "packages", "flair-tool-descriptors", "src", "index.ts"),
    ],
  };
}

export function resourcesInputs(root: string): string[] {
  return resourceBuild(root).inputs;
}

export function isFlairSourceRoot(root: string): boolean {
  // Treat a Flair root as source if any root marker exists, even when another
  // watched input is missing. A directory whose only marker is resources/ and
  // that has no package.json entry at all (a test's probe app: a Harper
  // component that links the Flair package) is not the Flair package. Its caller
  // checks the supplied harperBinDir, which the probe-app fixtures set to the
  // Flair root they link.
  const present = (entry: string): boolean => {
    try {
      lstatSync(join(root, entry));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  };
  const markers = ["resources", "tsconfig.json", "scripts", "packages"].filter(present);
  if (markers.length === 0) return false;
  if (markers.length === 1 && markers[0] === "resources" && !present("package.json")) return false;
  const text = readFileSync(join(root, "package.json"), "utf-8");
  const pkg = JSON.parse(text);
  return pkg.name === "@tpsdev-ai/flair" && pkg.main === "./dist/resources/in-process-api.js";
}

export interface DistIssue {
  message: string;
  remedy: string;
}

/** Membership is scoped to dist/resources/; mtimes cover every watched input, including src/. */
export function distFreshnessIssues(root: string): DistIssue[] {
  const issues: DistIssue[] = [];
  const report = (message: string) => issues.push({ message, remedy: "bun run build" });
  try {
    const stamp = join(root, "dist", "build-info.json");
    readFileSync(stamp);
    const stampMtime = statSync(stamp).mtimeMs;
    const { inputs, config } = resourceBuild(root);
    const expected = new Set<string>();
    for (const source of config.fileNames) {
      if (/\.d\.[cm]?ts$/.test(source)) continue;
      for (const output of ts.getOutputFileNames(config, source, !ts.sys.useCaseSensitiveFileNames)) {
        if (output.startsWith(join(root, "dist", "resources") + sep)) expected.add(output);
      }
    }
    const builtResources = join(root, "dist", "resources");
    const builtEntries = entriesUnder(builtResources);
    const built = builtEntries.filter((entry) => !entry.directory);
    const actual = new Set(built.map((entry) => entry.path));
    for (const output of expected) {
      if (!actual.has(output)) report(`${relative(root, output)} is missing`);
    }
    for (const output of actual) {
      if (!expected.has(output)) report(`${relative(root, output)} has no source in the resources build configuration`);
    }
    if (!built.length) report(`${relative(root, builtResources)} contains no built resources`);
    else {
      const oldest = built.reduce((a, b) => a.mtimeMs < b.mtimeMs ? a : b);
      const watched = inputs.flatMap((path) => {
        if (path === join(root, "resources") || path === join(root, "src")) return entriesUnder(path);
        const st = statSync(path);
        readFileSync(path);
        return [{ path, mtimeMs: st.mtimeMs, directory: false }];
      });
      for (const entry of watched) {
        if (entry.mtimeMs > oldest.mtimeMs) {
          report(`${relative(root, entry.path)} (${new Date(entry.mtimeMs).toISOString()}) is newer than the oldest built resource ${relative(root, oldest.path)} (${new Date(oldest.mtimeMs).toISOString()})`);
        }
      }
    }
    for (const entry of builtEntries.filter((e) => e.directory)) {
      if (entry.mtimeMs > stampMtime) report(`${relative(root, entry.path)} directory is newer than dist/build-info.json`);
    }
  } catch (err) {
    report(`the build tree could not be read: ${(err as Error).message}`);
  }
  return issues;
}

export function assertFlairDistFresh(root: string): void {
  let issues: DistIssue[];
  try {
    if (!isFlairSourceRoot(root)) return;
    issues = distFreshnessIssues(root);
  } catch (err) {
    throw new Error(`[harper-lifecycle] refusing to start Harper: ${root} package identity could not be read: ${(err as Error).message}`);
  }
  if (issues.length === 0) return;
  const remedies = [...new Set(issues.map((i) => i.remedy))];
  throw new Error(
    `[harper-lifecycle] refusing to start Harper: ${root} dist/ freshness could not be verified.\n` +
      issues.map((i) => `  - ${i.message}`).join("\n") +
      `\nRebuild first: ${remedies.map((r) => `\`${r}\``).join(" then ")}.`,
  );
}
