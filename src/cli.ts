#!/usr/bin/env node
import { Command } from "commander";
import nacl from "tweetnacl";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const base = process.env.FLAIR_URL || "http://127.0.0.1:8787";
  const token = process.env.FLAIR_TOKEN;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

const program = new Command();
program.name("flair");

const identity = program.command("identity");
identity.command("register")
  .requiredOption("--id <id>")
  .requiredOption("--name <name>")
  .option("--role <role>")
  .action(async (opts) => {
    const kp = nacl.sign.keyPair();
    const now = new Date().toISOString();
    const agent = await api("POST", "/Agent", {
      id: opts.id,
      name: opts.name,
      role: opts.role,
      publicKey: b64(kp.publicKey),
      createdAt: now,
      updatedAt: now,
    });
    console.log(JSON.stringify({ agent, privateKey: b64(kp.secretKey) }, null, 2));
  });

identity.command("show").argument("<id>").action(async (id) => console.log(JSON.stringify(await api("GET", `/Agent/${id}`), null, 2)));
identity.command("list").action(async () => console.log(JSON.stringify(await api("GET", "/Agent"), null, 2)));
identity.command("add-integration")
  .requiredOption("--agent <agentId>")
  .requiredOption("--platform <platform>")
  .requiredOption("--encrypted-credential <ciphertext>")
  .action(async (opts) => {
    const now = new Date().toISOString();
    const out = await api("POST", "/Integration", {
      id: `${opts.agent}:${opts.platform}`,
      agentId: opts.agent,
      platform: opts.platform,
      encryptedCredential: opts.encryptedCredential,
      createdAt: now,
      updatedAt: now,
    });
    console.log(JSON.stringify(out, null, 2));
  });

const memory = program.command("memory");
memory.command("add").requiredOption("--agent <id>").requiredOption("--content <text>")
  .option("--durability <d>", "standard")
  .option("--tags <csv>")
  .action(async (opts) => {
    const out = await api("POST", "/Memory", {
      agentId: opts.agent,
      content: opts.content,
      durability: opts.durability,
      tags: opts.tags ? String(opts.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : undefined,
    });
    console.log(JSON.stringify(out, null, 2));
  });
memory.command("search").requiredOption("--agent <id>").requiredOption("--q <query>")
  .option("--tag <tag>")
  .action(async (opts) => console.log(JSON.stringify(await api("POST", "/MemorySearch", { agentId: opts.agent, q: opts.q, tag: opts.tag }), null, 2)));
memory.command("list").requiredOption("--agent <id>")
  .option("--tag <tag>")
  .action(async (opts) => {
    const q = new URLSearchParams({ agentId: opts.agent, ...(opts.tag ? { tag: opts.tag } : {}) }).toString();
    console.log(JSON.stringify(await api("GET", `/Memory?${q}`), null, 2));
  });

const soul = program.command("soul");
soul.command("set").requiredOption("--agent <id>").requiredOption("--key <key>").requiredOption("--value <value>")
  .option("--durability <d>", "permanent")
  .action(async (opts) => {
    const out = await api("POST", "/Soul", { id: `${opts.agent}:${opts.key}`, agentId: opts.agent, key: opts.key, value: opts.value, durability: opts.durability });
    console.log(JSON.stringify(out, null, 2));
  });
soul.command("get").argument("<id>").action(async (id) => console.log(JSON.stringify(await api("GET", `/Soul/${id}`), null, 2)));
soul.command("list").requiredOption("--agent <id>")
  .action(async (opts) => console.log(JSON.stringify(await api("GET", `/Soul?agentId=${encodeURIComponent(opts.agent)}`), null, 2)));

await program.parseAsync();
