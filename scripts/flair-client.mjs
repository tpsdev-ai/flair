#!/usr/bin/env node
/**
 * Flair CLI client with Ed25519 TPS auth.
 * Usage:
 *   node scripts/flair-client.mjs memory list
 *   node scripts/flair-client.mjs memory get <id>
 *   node scripts/flair-client.mjs memory write <content>
 *   node scripts/flair-client.mjs memory search <query>
 *   node scripts/flair-client.mjs soul set <key> <value>
 *   node scripts/flair-client.mjs soul get <id>
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
const AGENT_ID = process.env.FLAIR_AGENT_ID || 'flint';
const PRIV_KEY_PATH = process.env.FLAIR_PRIV_KEY || `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;

async function loadPrivateKey() {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  return subtle.importKey('pkcs8', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['sign']);
}

async function flairFetch(method, path, body = null) {
  const privKey = await loadPrivateKey();
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const headers = { 'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const [,, resource, action, ...rest] = process.argv;
if (!resource || !action) {
  console.error('Usage: flair-client.mjs <memory|soul|agent> <list|get|write|set|delete|search> [args]');
  process.exit(1);
}

const table = resource.charAt(0).toUpperCase() + resource.slice(1);

try {
  let result;
  switch (action) {
    case 'list':
      result = await flairFetch('GET', `/${table}/?agentId=${AGENT_ID}`);
      break;
    case 'get':
      result = await flairFetch('GET', `/${table}/${rest[0]}`);
      break;
    case 'write': {
      const content = rest.join(' ');
      result = await flairFetch('POST', `/${table}/`, {
        agentId: AGENT_ID, content, durability: 'standard', createdAt: new Date().toISOString(),
      });
      break;
    }
    case 'set': {
      const [key, ...v] = rest;
      result = await flairFetch('POST', `/${table}/`, {
        agentId: AGENT_ID, key, value: v.join(' '), durability: 'permanent', createdAt: new Date().toISOString(),
      });
      break;
    }
    case 'delete':
      result = await flairFetch('DELETE', `/${table}/${rest[0]}`);
      break;
    case 'search': {
      const query = rest.join(' ');
      result = await flairFetch('POST', '/MemorySearch/', { agentId: AGENT_ID, q: query, limit: 5 });
      if (result.results) {
        for (const r of result.results) {
          const date = r.createdAt?.slice(0, 10) || '?';
          const snippet = (r.content || '').replace(/\n/g, ' ').slice(0, 120);
          console.log(`[${r._score}] ${date} ${r.id}: ${snippet}`);
        }
        console.log(`\n${result.results.length} results`);
        process.exit(0);
      }
      break;
    }
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
