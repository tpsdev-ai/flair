/**
 * migrate-harness-memory.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair migrate-harness-memory` and its pure harness-memory parsers.
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { authFetch, resolveAdminUser } from "../lib/auth-resolve.js";
import { load as parseYaml } from "js-yaml";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type MigrateHarnessMemoryCli = {
  resolveHttpPort: (...args: any[]) => any;
};

let cli: MigrateHarnessMemoryCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: MigrateHarnessMemoryCli): void {
  cli = fns;
}

function resolveHttpPort(...args: any[]): any {
  return cli.resolveHttpPort(...args);
}

function resolveMemoryDir(target: string, agentId: string): string {
  switch (target) {
    case "claude-code": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".claude", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".claude", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    case "openclaw": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".openclaw", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".openclaw", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    case "pi": {
      const cwd = process.cwd();
      const encodedCwd = encodeURIComponent(cwd).replace(/%2F/g, "/");
      const memoryDir = join(homedir(), ".pi", "projects", encodedCwd, "memory");
      const resolved = resolve(memoryDir);
      const expectedRoot = join(homedir(), ".pi", "projects");
      if (!resolved.startsWith(expectedRoot + sep)) {
        throw new Error(`Memory dir must be within ${expectedRoot}, got ${resolved}`);
      }
      return resolved;
    }
    default:
      throw new Error(`Unknown target: ${target}. Valid: claude-code, openclaw, pi`);
  }
}

/** Parse a memory file with YAML frontmatter. */

function parseMemoryFile(filePath: string): {
  meta: { name?: string; description?: string; type?: string; tags?: string[] };
  body: string;
} {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  
  if (!lines[0].startsWith("---")) {
    return { meta: {}, body: raw };
  }
  
  let endIdx = 1;
  while (endIdx < lines.length && !lines[endIdx].startsWith("---")) {
    endIdx++;
  }
  
  const frontmatterLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);
  const yamlContent = frontmatterLines.join("\n");
  const meta: any = parseYaml(yamlContent) || {};
  
  return {
    meta: {
      name: meta.name,
      description: meta.description,
      type: meta.type,
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    },
    body: bodyLines.join("\n").trim(),
  };
}

/** Map memory type to durability. */

function mapDurability(type: string): "permanent" | "persistent" | "standard" | "ephemeral" {
  switch (type) {
    case "feedback":
    case "reference":
      return "permanent";
    case "project":
    case "user":
      return "persistent";
    default:
      return "standard";
  }
}

/** Extract keywords from filename for tags. */

function extractKeywordsFromFilename(filename: string): string[] {
  const base = filename.replace(/\.md$/, "");
  const withoutType = base.replace(/^(feedback|project|reference|user)_/, "");
  const parts = withoutType.split(/[_-]+/).map(p => p.toLowerCase());
  const stopwords = new Set(["the", "and", "for", "with", "about", "on", "in", "to", "of", "a", "an"]);
  return parts.filter(p => p.length > 2 && !stopwords.has(p));
}


export function register(program: Command): void {
// ─── flair migrate-harness-memory ───────────────────────────────────────────

/** Resolve the memory directory path for a target harness. */

program
  .command("migrate-harness-memory")
  .description("Migrate harness-local memories to Flair")
  .requiredOption("--target <target>", "Target harness: claude-code, openclaw, pi")
  .requiredOption("--agent <id>", "Agent ID to write memories under")
  .option("--dry-run", "Show what would be migrated without writing")
  .action(async (opts: { target: string; agent: string; dryRun: boolean }) => {
    const target = opts.target;
    const agentId = opts.agent;
    const dryRun = !!opts.dryRun;
    
    let memoryDir: string;
    try {
      memoryDir = resolveMemoryDir(target, agentId);
    } catch (e: any) {
      console.error(`Error resolving memory directory: ${e.message}`);
      process.exit(1);
    }
    
    if (!existsSync(memoryDir)) {
      console.error(`Error: Memory directory not found: ${memoryDir}`);
      process.exit(1);
    }
    
    const migratedDir = join(memoryDir, ".migrated");
    if (!dryRun) {
      mkdirSync(migratedDir, { recursive: true, mode: 0o700 });
    }
    
    console.log(`Migrating memories from ${memoryDir} to Flair (agentId=${agentId})`);
    if (dryRun) console.log("  (DRY RUN - no files will be modified)");
    
    const files = readdirSync(memoryDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith(".md") && d.name !== "MEMORY.md")
      .map(d => d.name)
      .sort();
    
    if (files.length === 0) {
      console.log("No memory files found.");
      return;
    }
    
    console.log(`Found ${files.length} memory file(s) to migrate.`);
    
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;
    
    for (const filename of files) {
      const sourcePath = join(memoryDir, filename);
      const migratedPath = join(migratedDir, filename);
      
      if (existsSync(migratedPath)) {
        console.log(`  ${filename}: already migrated, skipping`);
        skipCount++;
        continue;
      }
      
      console.log(`  Processing: ${filename}...`);
      
      let parsed: {
        meta: { name?: string; description?: string; type?: string; tags?: string[] };
        body: string;
      };
      
      try {
        parsed = parseMemoryFile(sourcePath);
      } catch (e: any) {
        console.error(`    Failed to parse: ${e.message}`);
        failCount++;
        continue;
      }
      
      let type = parsed.meta.type;
      if (!type) {
        if (filename.startsWith("feedback_")) type = "feedback";
        else if (filename.startsWith("project_")) type = "project";
        else if (filename.startsWith("reference_")) type = "reference";
        else type = "session";
      }
      
      const durability = mapDurability(type);
      const tags = [...(parsed.meta.tags || [])];
      const filenameTags = extractKeywordsFromFilename(filename);
      for (const t of filenameTags) {
        if (!tags.includes(t)) tags.push(t);
      }
      tags.push(type);
      
      const content = parsed.body;
      
      console.log(`    Type: ${type}, Durability: ${durability}`);
      console.log(`    Tags: ${tags.join(", ")}`);
      console.log(`    Content preview: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      
      if (!dryRun) {
        console.log(`    Writing to Flair...`);
        try {
          const httpUrl = `http://127.0.0.1:${resolveHttpPort({})}`;
          const agentKeyId = `${agentId}.key`;
          const keysDir = join(homedir(), ".flair", "keys");
          const keyPath = join(keysDir, agentKeyId);
          
          let authSuccess = false;
          if (existsSync(keyPath)) {
            const memoryId = `${agentId}-${randomUUID()}`;
            const body = {
              id: memoryId,
              agentId: agentId,
              content: content,
              type: type as any,
              durability: durability,
              tags: tags,
              createdAt: new Date().toISOString(),
            };
            const memoryPath = `/Memory/${memoryId}`;
            const res = await authFetch(httpUrl, agentId, keyPath, "PUT", memoryPath, body);
            if (res.ok) {
              authSuccess = true;
              console.log(`    Write to Flair successful (Ed25519 auth)`);
            }
          }
          
          if (!authSuccess) {
            const adminPass = process.env.FLAIR_ADMIN_PASS || process.env.HDB_ADMIN_PASSWORD || "";
            if (adminPass) {
              const memoryId = `${agentId}-${randomUUID()}`;
              const body = {
                id: memoryId,
                agentId: agentId,
                content: content,
                type: type as any,
                durability: durability,
                tags: tags,
                createdAt: new Date().toISOString(),
              };
              const memoryPath = `/Memory/${memoryId}`;
              const auth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}`;
              const res = await fetch(`${httpUrl}${memoryPath}`, {
                method: "PUT",
                headers: {
                  Authorization: auth,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
              });
              if (res.ok) {
                console.log(`    Write to Flair successful (Basic auth)`);
              } else {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text}`);
              }
            } else {
              throw new Error("No authentication method available");
            }
          }
          
          renameSync(sourcePath, migratedPath);
          console.log(`    Moved to .migrated/${filename}`);
        } catch (e: any) {
          console.error(`    Failed: ${e.message}`);
          failCount++;
          continue;
        }
      } else {
        console.log(`    [dry-run] Would write to Flair and move to .migrated/${filename}`);
      }
      
      successCount++;
    }
    
    console.log(`\nMigration complete:`);
    console.log(`  Processed: ${files.length}`);
    console.log(`  Successful: ${successCount}`);
    console.log(`  Skipped: ${skipCount}`);
    console.log(`  Failed: ${failCount}`);
    
    if (failCount > 0) {
      process.exit(1);
    }
  });

}
