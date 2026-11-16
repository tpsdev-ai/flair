/**
 * Subprocess for the flair#930 fail-closed version probe.
 * PROBE_URL is the application URL. WORK_DIR receives a marker file if
 * npm install or deploy runs. Exit 0 only when fabricUpgrade returns.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fabricUpgrade } from "../../src/fabric-upgrade.ts";

const target = process.env.PROBE_URL;
const work = process.env.WORK_DIR ?? process.cwd();
if (!target) {
  console.error("PROBE_URL is required");
  process.exit(2);
}

function mark(name: string): void {
  writeFileSync(join(work, name), "written\n");
}

try {
  await fabricUpgrade(
    { target, fabricUser: "admin", fabricPassword: "pw" },
    {
      fetchLatestFlairVersion: async () => "9.9.9",
      fetchDeclaredHarperVersion: async () => "5.3.1",
      npmInstall: () => mark("npm-install"),
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
