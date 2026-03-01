#!/usr/bin/env node
/**
 * Sync MEMORY.md and SOUL.md to Flair soul entries.
 * Run after updating either file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
const AGENT_ID = process.env.FLAIR_AGENT_ID || 'flint';
const PRIV_KEY_PATH = process.env.FLAIR_PRIV_KEY || `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;
const WORKSPACE = `${process.env.HOME}/.openclaw/workspace-${AGENT_ID}`;

async function loadPrivateKey() {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  return subtle.importKey('pkcs8', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['sign']);
}

async function flairFetch(method, path, body, privKey) {
  const ts = Date.now().toString(), nonce = webcrypto.randomUUID();
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(`${AGENT_ID}:${ts}:${nonce}:${method}:${path}`));
  const headers = { 'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status };
}

const privKey = await loadPrivateKey();

const soulEntries = [
  { key: 'long-term-memory', file: 'MEMORY.md' },
  { key: 'identity', file: 'SOUL.md' },
  { key: 'role', value: 'Strategic cofounder at LifestyleLab. Direct, sharp, first principles.' },
];

for (const entry of soulEntries) {
  let value = entry.value;
  if (entry.file) {
    const path = `${WORKSPACE}/${entry.file}`;
    if (!existsSync(path)) { console.log(`  ${entry.key}: SKIP (${entry.file} not found)`); continue; }
    value = readFileSync(path, 'utf8').trim();
  }
  
  const body = { agentId: AGENT_ID, key: entry.key, value, durability: 'permanent', createdAt: new Date().toISOString() };
  const r = await flairFetch('POST', '/Soul/', body, privKey);
  console.log(`  ${entry.key}: ${r.ok ? 'synced' : `FAILED (${r.status})`} (${value.length} chars)`);
}
