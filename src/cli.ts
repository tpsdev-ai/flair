#!/usr/bin/env node
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { addIntegration, getAgent, listAgents, listIntegrations, upsertAgent } from "./store.js";

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
    const row = upsertAgent({
      id: opts.id,
      name: opts.name,
      role: opts.role,
      publicKey: b64(kp.publicKey),
      createdAt: now,
      updatedAt: now,
    });

    // Private key output is local-only for operator handoff; never sent to API.
    console.log(JSON.stringify({
      agent: row,
      privateKey: b64(kp.secretKey),
      note: "Store privateKey in runtime keychain; Flair backend never receives private key.",
    }, null, 2));
  });

identity.command("show")
  .argument("<id>")
  .action((id) => {
    const row = getAgent(id);
    if (!row) {
      console.error("agent not found");
      process.exit(1);
    }
    console.log(JSON.stringify(row, null, 2));
  });

identity.command("list")
  .action(() => {
    console.log(JSON.stringify(listAgents(), null, 2));
  });

identity.command("add-integration")
  .requiredOption("--agent <agentId>")
  .requiredOption("--platform <platform>")
  .option("--username <username>")
  .option("--userid <userId>")
  .option("--email <email>")
  .requiredOption("--encrypted-credential <ciphertext>")
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

program.parse();
