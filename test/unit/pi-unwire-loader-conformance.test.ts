import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = join(import.meta.dir, "../../packages/pi-flair");
const clientsUrl = pathToFileURL(join(import.meta.dir, "../../src/install/clients.ts")).href;
const purgeUrl = pathToFileURL(join(import.meta.dir, "../../src/lib/uninstall-purge.ts")).href;
let fixture: string | undefined;
const previousPiDir = process.env.PI_CODING_AGENT_DIR;

function readPiSettings(home: string, project: string, sources: string[] = [], unwire = false, purge = false): { settingsPath: string; result?: { ok: boolean; removed: boolean }; backupPresent: boolean; packages: unknown[]; extensions: string[]; resolved: { source: string; type: string; name?: string; path?: string; localCandidate: boolean; flairOwned: boolean; flairPath?: string }[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.env.PI_CODING_AGENT_DIR === undefined) delete env.PI_CODING_AGENT_DIR;
  const script = `
    import { existsSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { pathToFileURL } from "node:url";
    const entry = Bun.resolveSync("@earendil-works/pi-coding-agent", ${JSON.stringify(workspace)});
    const { SettingsManager } = await import(pathToFileURL(join(dirname(entry), "core/settings-manager.js")).href);
    const { DefaultPackageManager } = await import(pathToFileURL(join(dirname(entry), "core/package-manager.js")).href);
    const { getAgentDir } = await import(pathToFileURL(join(dirname(entry), "config.js")).href);
    const { isLocalPath } = await import(pathToFileURL(join(dirname(entry), "utils/paths.js")).href);
    const { ALL_CLIENTS, isFlairOwnedPiEntry, piSettingsPath, resolvePiExtensionPath } = await import(${JSON.stringify(clientsUrl)});
    const settingsPath = piSettingsPath();
    const result = ${unwire} ? ALL_CLIENTS.find(client => client.id === "pi").unwire() : undefined;
    if (${purge}) {
      const { purgeFlairInstall } = await import(${JSON.stringify(purgeUrl)});
      purgeFlairInstall({ homeDir: ${JSON.stringify(home)}, skipSchedulerUnload: true, omitNpmLeftover: true });
    }
    const backupPresent = existsSync(settingsPath + ".bak");
    const loader = SettingsManager.create(${JSON.stringify(project)});
    const manager = new DefaultPackageManager({ cwd: ${JSON.stringify(project)}, agentDir: getAgentDir(), settingsManager: loader });
    const resolved = ${JSON.stringify(sources)}.map(source => {
      const parsed = manager.parseSource(source);
      const base = manager.getBaseDirForScope("user");
      return { source, type: parsed.type, name: parsed.name, localCandidate: isLocalPath(source),
        path: parsed.type === "local" ? manager.resolvePathFromBase(parsed.path, base) : undefined,
        flairOwned: isFlairOwnedPiEntry(source),
        flairPath: parsed.type === "local" ? resolvePiExtensionPath(source, ${JSON.stringify(home)}, base) : undefined };
    });
    console.log(JSON.stringify({ settingsPath, result, backupPresent, packages: loader.getPackages(), extensions: loader.getExtensionPaths(), resolved }));
  `;
  let child: ReturnType<typeof Bun.spawnSync>;
  try {
    child = Bun.spawnSync([process.execPath, "--eval", script], {
      env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
  } catch (error) {
    throw new Error(`pi loader child failed to start: ${String(error)}; stderr: unavailable`);
  }
  const stderr = child.stderr?.toString() ?? "";
  const stdout = child.stdout?.toString() ?? "";
  if (!child.success) throw new Error(`pi loader child exited ${child.exitCode}; stderr: ${stderr}`);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`pi loader child returned non-JSON: ${String(error)}; stdout: ${stdout}; stderr: ${stderr}`);
  }
}

afterEach(() => {
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe("pi settings loader conformance", () => {
  for (const override of ["default", "absolute", "tilde", "home", "file-url"]) {
    it(`reads unwire results through pi's file loader with the ${override} agent directory`, () => {
      const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
      const library = "@earendil-works/pi-coding-agent";
      expect(manifest.devDependencies[library]).toBeDefined();
      fixture = mkdtempSync(join(tmpdir(), "flair-pi-loader-"));
      const home = join(fixture, "home");
      const project = join(fixture, "project");
      mkdirSync(home);
      mkdirSync(project);
      const agentDir = override === "default" ? join(home, ".pi/agent") : override === "home" ? home : join(home, "alt");
      if (override === "default") delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = override === "tilde" ? "~/alt" : override === "home" ? "~" : override === "file-url" ? pathToFileURL(agentDir).href : agentDir;
      const canonical = "npm:@tpsdev-ai/pi-flair";
      const documented = "~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/dist/index.js";
      const lookalikes = [
        "npm:@other/pi-flair", "~/work/pi-flair/notes.js", "~/dist/pi-flair-notes.js",
        "npm:@tpsdev-ai/pi-flair@", "npm:", "npm:   ", " npm:@tpsdev-ai/pi-flair",
        "npm:@tpsdev-ai/pi flair", "npm: @other/pi-flair ",
        "~/node_modules/@tpsdev-ai/pi-flair/../../../notes.js",
        "node_modules/@tpsdev-ai/pi-flair/../../../notes.js",
        "npm:@tpsdev-ai/pi-flair@ leading", "npm:@tpsdev-ai/pi-flair@1.0 x",
      ];
      const owned = [
        canonical, "npm: @tpsdev-ai/pi-flair", "npm:@tpsdev-ai/pi-flair ",
        "npm: @tpsdev-ai/pi-flair@0.50.0", "npm:@tpsdev-ai/pi-flair@0.50.0 ",
        "~/node_modules/@tpsdev-ai/pi-flair/dist/../index.js",
        "node_modules/@tpsdev-ai/pi-flair/dist/../index.js",
        "~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/../pi-flair/dist/index.js",
        pathToFileURL(join(home, "node_modules/@tpsdev-ai/pi-flair/dist/index.js")).href,
      ];
      const packages = [...owned, { source: `${canonical}@latest`, extensions: ["dist/index.js"] }, ...lookalikes];
      const extensions = [documented, ...owned, ...lookalikes];
      const path = join(agentDir, "settings.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ packages, extensions }));
      const cases = [...owned, ...lookalikes.filter(source => !source.includes("@ leading") && !source.includes("@1.0 x"))];
      const before = readPiSettings(home, project, cases);
      expect(before.settingsPath).toBe(path);
      for (const answer of before.resolved) {
        const segments = answer.path?.split(sep) ?? [];
        const inside = segments.some((segment, index) => segment === "node_modules" && segments[index + 1] === "@tpsdev-ai" && segments[index + 2] === "pi-flair" && index + 3 < segments.length);
        const ownedByPi = answer.type === "npm" ? answer.name === "@tpsdev-ai/pi-flair" : answer.localCandidate && inside;
        expect(answer.flairOwned).toBe(ownedByPi);
        if (answer.path) expect(answer.flairPath).toBe(answer.path);
      }
      expect(before.packages).toEqual(packages);
      expect(before.extensions).toEqual(extensions);
      const after = readPiSettings(home, project, [], true);
      expect(after.result?.ok).toBe(true);
      expect(after.result?.removed).toBe(true);
      expect(after.packages).toEqual(lookalikes);
      expect(after.extensions).toEqual(lookalikes);
    });
  }

  for (const prefix of ["https:", "http:", "ssh:", "github:", "git:", "npm:"]) {
    for (const whitespace of ["", " "]) {
      it(`preserves bytes for ${JSON.stringify(whitespace + prefix)} sources containing package-path segments`, () => {
        fixture = mkdtempSync(join(tmpdir(), "flair-pi-loader-"));
        const home = join(fixture, "home");
        const project = join(fixture, "project");
        mkdirSync(home);
        mkdirSync(project);
        process.env.PI_CODING_AGENT_DIR = join(home, "alt");
        const source = `${whitespace}${prefix}//example.test/owner/repo/node_modules/@tpsdev-ai/pi-flair/index.js`;
        const path = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
        mkdirSync(dirname(path), { recursive: true });
        const bytes = JSON.stringify({ packages: [source, { source }], extensions: [source] }, null, 4) + "\n";
        writeFileSync(path, bytes);
        const after = readPiSettings(home, project, [source], true);
        const answer = after.resolved[0];
        expect(readFileSync(path, "utf8")).toBe(bytes);
        expect(answer.localCandidate).toBe(false);
        const piType = prefix === "npm:" && !whitespace ? "npm" : ["github:", "git:", "npm:"].includes(prefix) ? "local" : "git";
        expect(answer.type).toBe(piType);
        expect(answer.flairOwned).toBe(false);
        expect(after.result?.ok).toBe(true);
        expect(after.result?.removed).toBe(false);
      });
    }
  }
});

describe("purge applies Flair's shared ownership rule to packages and extensions", () => {
  const cases: [string, string][] = [
    ["the documented npm source", "npm:@tpsdev-ai/pi-flair"],
    ["a local package path inside the pi-flair package", "~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/dist/index.js"],
    ["an unrelated path", "~/dist/pi-flair-notes.js"],
    ["another package named pi-flair", "npm:@other/pi-flair"],
    ["a leading-whitespace npm source", " npm:@tpsdev-ai/pi-flair"],
    ["an empty-spec npm source", "npm:@tpsdev-ai/pi-flair@"],
  ];

  for (const field of ["packages", "extensions"] as const) {
    for (const [label, source] of cases) {
      it(`purge applies Flair's shared ownership rule to ${label} in ${field} only`, () => {
        fixture = mkdtempSync(join(tmpdir(), "flair-pi-loader-"));
        const home = join(fixture, "home");
        const project = join(fixture, "project");
        mkdirSync(home);
        mkdirSync(project);
        // The directory override: pi's loader and purge must read the same file.
        process.env.PI_CODING_AGENT_DIR = join(home, "alt-agent");
        const path = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
        mkdirSync(dirname(path), { recursive: true });
        // ONE field per case: a field-specific ownership gap cannot hide behind
        // the other field, and the assertion covers only this field's source.
        const settings = field === "packages" ? { packages: [source] } : { extensions: [source] };
        const bytes = JSON.stringify(settings, null, 4) + "\n";
        writeFileSync(path, bytes);
        writeFileSync(`${path}.bak`, bytes);

        const after = readPiSettings(home, project, [source], false, true);
        const answer = after.resolved[0]!;
        const segments = answer.path?.split(sep) ?? [];
        const inside = segments.some((segment, index) =>
          segment === "node_modules" && segments[index + 1] === "@tpsdev-ai" &&
          segments[index + 2] === "pi-flair" && index + 3 < segments.length);
        const loaderOwns = answer.type === "npm"
          ? answer.name === "@tpsdev-ai/pi-flair"
          : answer.localCandidate && inside;

        expect(after.settingsPath).toBe(path);
        // Flair's shared ownership rule applies to both fields; pi's source
        // parser agrees for packages sources.
        expect(after.backupPresent).toBe(!loaderOwns);
      }, 15_000);
    }
  }
});
