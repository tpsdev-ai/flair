/**
 * inspect.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair backup inspect`.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import * as render from "../render.js";
import { existsSync, readFileSync } from "node:fs";

export function register(program: Command): void {
// ─── flair backup inspect ────────────────────────────────────────────────────


program
  .command("inspect <path>")
  .description("Show contents of a backup or export file")
  .option("--json", "Emit raw JSON of the file (also: pipe + FLAIR_OUTPUT=json)")
  .action(async (filePath, opts) => {
    if (!existsSync(filePath)) {
      console.error(`${render.icons.error} File not found: ${render.wrap(render.c.dim, filePath)}`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON(data));
      return;
    }

    console.log(`${render.wrap(render.c.bold, "File:")}    ${render.wrap(render.c.dim, filePath)}`);
    const type = data.type ?? "full-backup";
    const typeColor = type === "agent-export" ? render.c.cyan : render.c.magenta;
    console.log(render.kv("Type", render.wrap(typeColor, type)));
    console.log(render.kv("Created", String(data.createdAt ?? data.exportedAt ?? render.wrap(render.c.dim, "unknown"))));
    console.log(render.kv("Source", String(data.source ?? render.wrap(render.c.dim, "unknown"))));

    if (data.type === "agent-export") {
      console.log(`\n${render.wrap(render.c.bold, "Agent")}: ${render.wrap(render.c.bold, data.agent?.id ?? "unknown")}`);
      console.log(render.kv("Name", String(data.agent?.name ?? data.agent?.id ?? "—")));
      console.log(render.kv("Memories", render.wrap(render.c.bold, String((data.memories ?? []).length))));
      console.log(render.kv("Souls", render.wrap(render.c.bold, String((data.souls ?? []).length))));
      console.log(render.kv("Grants", render.wrap(render.c.bold, String((data.grants ?? []).length))));
      const keyText = data.privateKey ? render.wrap(render.c.magenta, "yes") : render.wrap(render.c.dim, "no");
      console.log(render.kv("Key included", keyText));
    } else {
      const agents = data.agents ?? [];
      console.log(`\n${render.wrap(render.c.bold, "Agents")}: ${render.wrap(render.c.bold, String(agents.length))}`);
      for (const a of agents) {
        console.log(`  ${render.wrap(render.c.dim, "·")} ${render.wrap(render.c.bold, a.id)} ${render.wrap(render.c.dim, `(${a.name ?? a.id})`)}`);
      }
      console.log(render.kv("Memories", render.wrap(render.c.bold, String((data.memories ?? []).length))));
      console.log(render.kv("Souls", render.wrap(render.c.bold, String((data.souls ?? []).length))));
    }
  });

}
