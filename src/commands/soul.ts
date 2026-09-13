/**
 * soul.ts — `flair soul` command group (flair#1622 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration and action handlers. Shared CLI helpers
 * (api, resolveSigningAgentId, credential flags, …) stay in cli.ts and
 * are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import * as render from "../render.js";
import type { ResolvedSigningIdentity } from "../lib/signing-identity.js";

export type SoulCli = {
  api: (...args: any[]) => Promise<any>;
  resolveSigningAgentId: (opts: { agent?: string }, command?: string) => ResolvedSigningIdentity;
  applyAdminPassFile: (opts: { adminPass?: string; adminPassFile?: string }) => void;
  addSharedCredentialOptions: (cmd: Command) => Command;
};

let cli: SoulCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: SoulCli): void {
  cli = fns;
}

function api(...args: any[]): Promise<any> {
  return cli.api(...args);
}
function resolveSigningAgentId(opts: { agent?: string }, command?: string): ResolvedSigningIdentity {
  return cli.resolveSigningAgentId(opts, command);
}
function applyAdminPassFile(opts: { adminPass?: string; adminPassFile?: string }): void {
  cli.applyAdminPassFile(opts);
}
function addSharedCredentialOptions(cmd: Command): Command {
  return cli.addSharedCredentialOptions(cmd);
}

export function register(program: Command): void {
  const soul = program.command("soul").description("Manage agent soul entries");
  addSharedCredentialOptions(soul.command("set"))
    .description("Set (upsert) a soul entry for an agent by key")
    .requiredOption("--agent <id>")
    .requiredOption("--key <key>")
    .requiredOption("--value <value>")
    .option("--durability <d>", "permanent|persistent|standard|ephemeral (default permanent — soul entries are identity, not working memory)")
    .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts: any) => {
      applyAdminPassFile(opts);
      // PUT /Soul/{agentId:key} (upsert by id), matching flair-client's soul.set().
      // The Soul table resource has no POST handler, so a collection POST /Soul
      // 405s; the record must be written by its primary key. (#498)
      //
      // flair#1183: resolve the SIGNING identity through the canonical seam and
      // thread it to api(). --agent is required, so the flag always wins the
      // precedence — but before this, api() re-derived the signer as
      // FLAIR_AGENT_ID-first, so `soul set --agent X` with FLAIR_AGENT_ID=Y set
      // wrote a record owned by X while signing as Y (the soul family's stale rung).
      const { agentId, source } = resolveSigningAgentId(opts, "soul set");
      const id = `${opts.agent}:${opts.key}`;
      const out = await api("PUT", `/Soul/${encodeURIComponent(id)}`, {
        id,
        agentId: opts.agent,
        key: opts.key,
        value: opts.value,
        durability: opts.durability,
        createdAt: new Date().toISOString(),
      }, { agentId, agentIdSource: source, explicitAdminPass: opts.adminPass, adminUser: opts.adminUser });
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(out));
        return;
      }
      console.log(`${render.icons.ok} ${render.wrap(render.c.green, "soul entry set")}`);
      console.log(render.kv("agent", opts.agent));
      console.log(render.kv("key", render.wrap(render.c.bold, opts.key)));
      console.log(render.kv("value", String(opts.value)));
      if (opts.durability) console.log(render.kv("durability", render.wrap(render.c.magenta, opts.durability)));
    });

  soul.command("get")
    .description("Fetch a single soul entry by id (agent:key)")
    .argument("<id>")
    .option("--agent <id>", "Agent ID to sign the read as (or set FLAIR_AGENT_ID); falls back to the config-profile agent")
    .option("--json", "Emit raw JSON response (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (id: string, opts: any) => {
      // flair#1183: /Soul reads are verified (any registered agent). Resolve the
      // signer through the canonical seam so soul get honors the SAME precedence
      // as every other family; a null result lets api() fall to admin-pass/floor.
      const { agentId, source } = resolveSigningAgentId(opts, "soul get");
      const out = await api("GET", `/Soul/${id}`, undefined, { agentId, agentIdSource: source });
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(out));
        return;
      }
      if (!out || (typeof out === "object" && !out.id)) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "no entry")}`);
        return;
      }
      console.log(render.wrap(render.c.bold, out.id ?? id));
      if (out.agentId) console.log(render.kv("agent", out.agentId));
      if (out.key) console.log(render.kv("key", out.key));
      if (out.value !== undefined) console.log(render.kv("value", String(out.value)));
      if (out.durability) console.log(render.kv("durability", render.wrap(render.c.magenta, String(out.durability))));
      if (out.priority) console.log(render.kv("priority", String(out.priority)));
      if (out.createdAt) console.log(render.kv("created", `${render.relativeTime(out.createdAt)} ${render.wrap(render.c.dim, `(${out.createdAt})`)}`));
      if (out.updatedAt && out.updatedAt !== out.createdAt) {
        console.log(render.kv("updated", `${render.relativeTime(out.updatedAt)} ${render.wrap(render.c.dim, `(${out.updatedAt})`)}`));
      }
    });

  soul.command("list")
    .description("List all soul entries for an agent")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--json", "Emit raw JSON array (also: pipe + FLAIR_OUTPUT=json)")
    .action(async (opts: any) => {
      const { agentId, source } = resolveSigningAgentId(opts, "soul list");
      if (!agentId) {
        console.error(`${render.icons.error} --agent <id> required (or set FLAIR_AGENT_ID)`);
        process.exit(2);
      }
      const out = await api("GET", `/Soul?agentId=${encodeURIComponent(agentId)}`, undefined, { agentId, agentIdSource: source });
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(out));
        return;
      }
      const all: any[] = Array.isArray(out) ? out : (out?.results ?? out?.items ?? []);
      if (all.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, `no soul entries for agent ${agentId}`)}`);
        return;
      }
      console.log(
        `${render.wrap(render.c.bold, String(all.length))} soul entries for agent ${render.wrap(render.c.bold, agentId)}\n`,
      );
      const priorityColor = (p: string): string => {
        if (p === "critical") return render.c.red;
        if (p === "high") return render.c.yellow;
        if (p === "low") return render.c.gray;
        return render.c.cyan;
      };
      const cols: render.TableColumn[] = [
        { label: "key", key: "key", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
        {
          label: "priority",
          key: "priority",
          format: (v) => {
            const p = String(v ?? "standard");
            return render.wrap(priorityColor(p), p);
          },
        },
        {
          label: "durability",
          key: "durability",
          format: (v) => {
            const d = String(v ?? "—");
            return d === "permanent" ? render.wrap(render.c.magenta, d) : render.wrap(render.c.dim, d);
          },
        },
        {
          label: "value",
          key: "value",
          format: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 80),
        },
      ];
      console.log(render.table(cols, all as Array<Record<string, unknown>>));
    });
}
