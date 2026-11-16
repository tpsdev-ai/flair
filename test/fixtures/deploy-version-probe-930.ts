/**
 * Subprocess for the flair#930 fail-closed version probe.
 * PROBE_URL is the application URL. WORK_DIR receives a marker file if
 * npm install or deploy runs. Exit 0 only when fabricUpgrade returns.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HARPER_PIN, fabricUpgrade } from "../../src/fabric-upgrade.ts";

const target = process.env.PROBE_URL;
const work = process.env.WORK_DIR ?? process.cwd();
if (!target) {
  console.error("PROBE_URL is required");
  process.exit(2);
}

function mark(name: string): void {
  appendFileSync(join(work, name), "written\n");
}

function plantStagedHarper(dir: string): void {
  const harperDir = join(dir, "node_modules", "harper");
  mkdirSync(harperDir, { recursive: true });
  writeFileSync(join(harperDir, "package.json"), JSON.stringify({ name: "harper", version: DEFAULT_HARPER_PIN }));
  const flairDir = join(dir, "node_modules", "@tpsdev-ai", "flair");
  mkdirSync(flairDir, { recursive: true });
  writeFileSync(join(flairDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "9.9.9", files: ["dist"] }));
}

try {
  await fabricUpgrade(
    { target, fabricUser: "admin", fabricPassword: "pw" },
    {
      fetchLatestFlairVersion: async () => "9.9.9",
      fetchDeclaredHarperVersion: async () => "5.3.1",
      npmInstall: (dir: string) => {
        mark("npm-install");
        plantStagedHarper(dir);
      },
      deploy: async () => {
        mark("deploy");
        return { url: target, project: "flair", version: "9.9.9", packageRoot: work, dryRun: false };
      },
      log: (m: string) => console.log(m),
    },
  );
  console.log("UPGRADE_COMPLETE");
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
