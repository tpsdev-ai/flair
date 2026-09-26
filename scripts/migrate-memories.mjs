#!/usr/bin/env node
/**
 * Migrate flat-file daily memories into Flair.
 * Usage: FLAIR_AGENT_ID=<id> node scripts/migrate-memories.mjs <memory-dir>/
 *        node scripts/migrate-memories.mjs --agent <id> <memory-dir>/
 */
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join, basename } from 'node:path';
import { takeAgentFlag, requireAgentIdentity } from './lib/agent-identity.mjs';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';

// Identity (flair#1822): the caller's, never a shipped default. Refused before
// any key load or network call. `--agent <id>` or FLAIR_AGENT_ID.
const { agentId: agentFromFlag, rest: flagArgs } = takeAgentFlag(process.argv.slice(2));
const AGENT_ID = requireAgentIdentity({ flagValue: agentFromFlag, action: 'migrate memories' });
const PRIV_KEY_PATH = process.env.FLAIR_PRIV_KEY || `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;

async function loadPrivateKey() {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  const der = Buffer.from(b64, 'base64');
  return subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

async function flairPost(path, body, privKey) {
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:POST:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const sigB64 = Buffer.from(sig).toString('base64');
  const res = await fetch(`${FLAIR_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${sigB64}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.text();
}

const memoryDir = flagArgs[0];
if (!memoryDir) { console.error('Usage: migrate-memories.mjs [--agent <id>] <memory-dir>'); process.exit(1); }

const privKey = await loadPrivateKey();
const files = readdirSync(memoryDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/)).sort();

console.log(`Migrating ${files.length} daily memory files for agent ${AGENT_ID}...`);

for (const file of files) {
  const date = file.replace('.md', '');
  const content = readFileSync(join(memoryDir, file), 'utf8').trim();
  if (!content) continue;
  
  const id = `${AGENT_ID}-daily-${date}`;
  const result = await flairPost('/Memory/', {
    id,
    agentId: AGENT_ID,
    content,
    tags: ['daily-log', date],
    durability: 'persistent',
    source: `memory/${file}`,
    createdAt: `${date}T00:00:00Z`,
  }, privKey);
  console.log(`  ${file} → ${result}`);
}

console.log('Migration complete.');
