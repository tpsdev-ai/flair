#!/usr/bin/env node
/**
 * Flair CLI client with Ed25519 TPS auth.
 * Usage:
 *   node scripts/flair-client.mjs memory list
 *   node scripts/flair-client.mjs memory get <id>
 *   node scripts/flair-client.mjs memory write <content>
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
  const der = Buffer.from(b64, 'base64');
  return subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

async function signRequest(method, path, privKey) {
  const timestamp = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${timestamp}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const sigB64 = Buffer.from(sig).toString('base64');
  return { timestamp, nonce, signature: sigB64 };
}

async function flairFetch(method, path, body = null) {
  const privKey = await loadPrivateKey();
  const { timestamp, nonce, signature } = await signRequest(method, path, privKey);
  const headers = {
    'Authorization': `TPS-Ed25519 ${AGENT_ID}:${timestamp}:${nonce}:${signature}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const [,, resource, action, ...rest] = process.argv;
if (!resource || !action) {
  console.error('Usage: flair-client.mjs <memory|soul|agent> <list|get|write|set|delete> [args]');
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
        agentId: AGENT_ID, content,
        durability: 'standard',
        createdAt: new Date().toISOString(),
      });
      break;
    }
    case 'set': {
      const [key, ...v] = rest;
      result = await flairFetch('POST', `/${table}/`, {
        agentId: AGENT_ID, key, value: v.join(' '),
        durability: 'permanent',
        createdAt: new Date().toISOString(),
      });
      break;
    }
    case 'delete':
      result = await flairFetch('DELETE', `/${table}/${rest[0]}`);
      break;
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
