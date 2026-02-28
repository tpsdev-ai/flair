#!/usr/bin/env node
import { Command } from "commander";
import nacl from "tweetnacl";
import { addIntegration, createMemory, getAgent, getSoul, listAgents, listMemories, listSouls, searchMemories, upsertAgent, upsertSoul } from "./store.js";
import type { Durability } from "./types.js";

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }

const program = new Command();
program.name("flair").description("Flair CLI");

const identity = program.command("identity").description("Identity commands");
identity.command("register")
  .requiredOption("--id <id>")
  .requiredOption("--name <name>")
  .option("--role <role>")
  .action((opts) => {
    const kp = nacl.sign.keyPair();
    const now = new Date().toISOString();
    const row = upsertAgent({ id: opts.id, name: opts.name, role: opts.role, publicKey: b64(kp.publicKey), createdAt: now, updatedAt: now });
    console.log(JSON.stringify({ agent: row, privateKey: b64(kp.secretKey), note: "Store privateKey in runtime keychain; Flair backend never receives private key." }, null, 2));
  });
identity.command("show").argument("<id>").action((id) => {
  const row = getAgent(id);
  if (!row) { console.error("agent not found"); process.exit(1); }
  console.log(JSON.stringify(row, null, 2));
});
identity.command("list").action(() => console.log(JSON.stringify(listAgents(), null, 2)));
identity.command("add-integration")
  .requiredOption("--agent <agentId>")
  .requiredOption("--platform <platform>")
  .requiredOption("--encrypted-credential <ciphertext>")
  .option("--username <username>")
  .option("--userid <userId>")
  .option("--email <email>")
  .option("--metadata <json>")
  .action((opts) => {
    const row = addIntegration({
      id: `${opts.agent}:${opts.platform}`,
      agentId: opts.agent,
      platform: opts.platform,
      username: opts.username,
      userId: opts.userid,
      email: opts.email,
      encryptedCredential: opts.encryptedCredential,
      metadata: opts.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify(row, null, 2));
  });

const memory = program.command("memory").description("Memory commands");
memory.command("add")
  .requiredOption("--agent <agentId>")
  .requiredOption("--content <text>")
  .option("--tags <csv>")
  .option("--source <source>")
  .option("--durability <durability>", "permanent|persistent|standard|ephemeral", "standard")
  .action((opts) => {
    const row = createMemory({
      agentId: opts.agent,
      content: opts.content,
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
      source: opts.source,
      durability: opts.durability as Durability,
    });
    console.log(JSON.stringify(row, null, 2));
  });
memory.command("search")
  .requiredOption("--agent <agentId>")
  .requiredOption("--q <query>")
  .option("--tag <tag>")
  .action((opts) => {
    console.log(JSON.stringify(searchMemories({ agentId: opts.agent, q: opts.q, tag: opts.tag }), null, 2));
  });
memory.command("list")
  .requiredOption("--agent <agentId>")
  .option("--tag <tag>")
  .action((opts) => {
    console.log(JSON.stringify(listMemories({ agentId: opts.agent, tag: opts.tag }), null, 2));
  });

const soul = program.command("soul").description("Soul commands");
soul.command("set")
  .requiredOption("--agent <agentId>")
  .requiredOption("--key <key>")
  .requiredOption("--value <value>")
  .option("--durability <durability>", "permanent|persistent|standard|ephemeral", "permanent")
  .action((opts) => {
    const row = upsertSoul({ agentId: opts.agent, key: opts.key, value: opts.value, durability: opts.durability as Durability });
    console.log(JSON.stringify(row, null, 2));
  });
soul.command("get")
  .argument("<id>")
  .action((id) => {
    const row = getSoul(id);
    if (!row) { console.error("soul not found"); process.exit(1); }
    console.log(JSON.stringify(row, null, 2));
  });
soul.command("list")
  .requiredOption("--agent <agentId>")
  .action((opts) => {
    console.log(JSON.stringify(listSouls(opts.agent), null, 2));
  });

program.parse();
