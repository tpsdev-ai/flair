#!/usr/bin/env node
/**
 * Flair sync — push today's daily log to Flair, or pull memories from Flair.
 * 
 * Usage:
 *   node flair-sync.mjs push              # Push today's memory file to Flair
 *   node flair-sync.mjs push 2026-02-28   # Push a specific date
 *   node flair-sync.mjs pull              # Pull all memories from Flair (JSON)
 *   node flair-sync.mjs pull-today        # Pull today's memory
 *   node flair-sync.mjs status            # Show Flair connection status + counts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
const AGENT_ID = process.env.FLAIR_AGENT_ID || 'flint';
const PRIV_KEY_PATH = process.env.FLAIR_PRIV_KEY || `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;
const MEMORY_DIR = process.env.FLAIR_MEMORY_DIR || `${process.env.HOME}/ops/agents/${AGENT_ID}/memory`;

async function loadPrivateKey() {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  return subtle.importKey('pkcs8', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['sign']);
}

async function flairFetch(method, path, body, privKey) {
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const headers = {
    'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; } catch { return { ok: res.ok, data: text }; }
}

const privKey = await loadPrivateKey();
const [,, cmd, arg] = process.argv;
const today = new Date().toISOString().slice(0, 10);

switch (cmd) {
  case 'push': {
    const date = arg || today;
    const file = `${MEMORY_DIR}/${date}.md`;
    if (!existsSync(file)) { console.error(`No file: ${file}`); process.exit(1); }
    const content = readFileSync(file, 'utf8').trim();
    const id = `${AGENT_ID}-daily-${date}`;
    
    // Try PUT (update) first, fall back to POST (create)
    let r = await flairFetch('PUT', `/Memory/${id}`, {
      id, agentId: AGENT_ID, content,
      tags: ['daily-log', date],
      durability: 'persistent',
      source: `memory/${date}.md`,
      createdAt: `${date}T00:00:00Z`,
    }, privKey);
    
    if (!r.ok) {
      r = await flairFetch('POST', '/Memory/', {
        id, agentId: AGENT_ID, content,
        tags: ['daily-log', date],
        durability: 'persistent',
        source: `memory/${date}.md`,
        createdAt: `${date}T00:00:00Z`,
      }, privKey);
    }
    console.log(`${date}: ${r.ok ? 'synced' : 'FAILED'} → ${JSON.stringify(r.data)}`);
    break;
  }
  case 'pull': {
    const r = await flairFetch('GET', `/Memory/?agentId=${AGENT_ID}`, null, privKey);
    if (r.ok) console.log(JSON.stringify(r.data, null, 2));
    else console.error('Failed:', r.data);
    break;
  }
  case 'pull-today': {
    const id = `${AGENT_ID}-daily-${today}`;
    const r = await flairFetch('GET', `/Memory/${id}`, null, privKey);
    if (r.ok && r.data) console.log(r.data.content);
    else console.error('No memory for today yet');
    break;
  }
  case 'status': {
    try {
      const mem = await flairFetch('GET', `/Memory/?agentId=${AGENT_ID}`, null, privKey);
      const soul = await flairFetch('GET', `/Soul/?agentId=${AGENT_ID}`, null, privKey);
      console.log(`Flair Status: CONNECTED`);
      console.log(`  Agent: ${AGENT_ID}`);
      console.log(`  Memories: ${Array.isArray(mem.data) ? mem.data.length : '?'}`);
      console.log(`  Soul entries: ${Array.isArray(soul.data) ? soul.data.length : '?'}`);
      if (Array.isArray(mem.data)) {
        const latest = mem.data.sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
        console.log(`  Latest: ${latest?.id} (${latest?.createdAt})`);
      }
    } catch (e) {
      console.log(`Flair Status: DISCONNECTED (${e.message})`);
    }
    break;
  }
  default:
    console.error('Usage: flair-sync.mjs <push|pull|pull-today|status> [date]');
    process.exit(1);
}
