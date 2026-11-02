import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_CLIENTS, isFlairOwnedPiEntry, piSettingsPath, resolvePiExtensionPath } from "../../src/install/clients.ts";
import { withHome } from "../../src/lib/home.ts";

const workspace = join(import.meta.dir, "../../packages/pi-flair");
const piClient = ALL_CLIENTS.find(client => client.id === "pi")!;
let fixture: string | undefined;
const previousPiDir = process.env.PI_CODING_AGENT_DIR;

function readPiSettings(home: string, project: string, sources: string[] = []): { packages: unknown[]; extensions: string[]; resolved: { source: string; type: string; name?: string; path?: string }[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.env.PI_CODING_AGENT_DIR === undefined) delete env.PI_CODING_AGENT_DIR;
  const script = `
    import { dirname, join } from "node:path";
    import { pathToFileURL } from "node:url";
    const entry = Bun.resolveSync("@earendil-works/pi-coding-agent", ${JSON.stringify(workspace)});
    const { SettingsManager } = await import(pathToFileURL(join(dirname(entry), "core/settings-manager.js")).href);
    const { DefaultPackageManager } = await import(pathToFileURL(join(dirname(entry), "core/package-manager.js")).href);
    const loader = SettingsManager.create(${JSON.stringify(project)});
    const manager = new DefaultPackageManager({ cwd: ${JSON.stringify(project)}, agentDir: ${JSON.stringify(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"))}, settingsManager: loader });
    const resolved = ${JSON.stringify(sources)}.map(source => {
      const parsed = manager.parseSource(source);
      return { source, type: parsed.type, name: parsed.name, path: parsed.type === "local" ? manager.resolvePathFromBase(parsed.path, manager.getBaseDirForScope("user")) : undefined };
    });
    console.log(JSON.stringify({ packages: loader.getPackages(), extensions: loader.getExtensionPaths(), resolved }));
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
  for (const override of [false, true]) {
    it(`reads unwire results through pi's file loader ${override ? "with the agent-directory override" : "in the default agent directory"}`, () => {
      const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
      const library = "@earendil-works/pi-coding-agent";
      expect(manifest.devDependencies[library]).toBeDefined();
      fixture = mkdtempSync(join(tmpdir(), "flair-pi-loader-"));
      const home = join(fixture, "home");
      const project = join(fixture, "project");
      mkdirSync(home);
      mkdirSync(project);
      if (override) process.env.PI_CODING_AGENT_DIR = join(fixture, "agent-override");
      else delete process.env.PI_CODING_AGENT_DIR;
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
      const path = withHome(home, () => piSettingsPath());
      expect(path).toBe(join(override ? process.env.PI_CODING_AGENT_DIR! : join(home, ".pi/agent"), "settings.json"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ packages, extensions }));
      const cases = [...owned, ...lookalikes.filter(source => !source.includes("@ leading") && !source.includes("@1.0 x"))];
      const before = readPiSettings(home, project, cases);
      for (const answer of before.resolved) {
        const segments = answer.path?.split(sep) ?? [];
        const inside = segments.some((segment, index) => segment === "node_modules" && segments[index + 1] === "@tpsdev-ai" && segments[index + 2] === "pi-flair" && index + 3 < segments.length);
        const ownedByPi = answer.type === "npm" ? answer.name === "@tpsdev-ai/pi-flair" : inside;
        expect(withHome(home, () => isFlairOwnedPiEntry(answer.source))).toBe(ownedByPi);
        if (answer.path) expect(resolvePiExtensionPath(answer.source, home, dirname(path))).toBe(answer.path);
      }
      expect(before.packages).toEqual(packages);
      expect(before.extensions).toEqual(extensions);
      const result = withHome(home, () => piClient.unwire());
      expect(result.ok).toBe(true);
      expect(result.removed).toBe(true);
      const after = readPiSettings(home, project);
      expect(after.packages).toEqual(lookalikes);
      expect(after.extensions).toEqual(lookalikes);
    });
  }
});
