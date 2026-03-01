#!/usr/bin/env node
/**
 * Minimal repro: Harper v5 "Transaction commit failed: Resource busy"
 *
 * When middleware (server.http) does tables.X.put() immediately after
 * forwarding a PUT to the same record, Harper crashes with:
 *   UnhandledPromiseRejection: Transaction commit failed: Resource busy
 *
 * The issue: the original PUT transaction hasn't committed yet when
 * the middleware's post-processing fires. RocksDB rejects the second
 * write on the same key.
 *
 * Workaround: setTimeout(fn, 500) before the post-processing put().
 * But this is fragile — there's no API to know when the transaction
 * commits.
 *
 * Steps to reproduce:
 * 1. Create a Harper v5 component with a simple @table @export resource
 * 2. Add server.http() middleware that:
 *    a. Calls nextLayer(request) to let Harper handle the write
 *    b. Immediately calls tables.MyTable.put() on the same record
 * 3. Send a PUT request
 * 4. Harper crashes with ERR_UNHANDLED_REJECTION: Resource busy
 *
 * Expected: either tables.X.put() should wait for the prior transaction,
 * or there should be a callback/event for "transaction committed".
 */

// This script demonstrates the issue conceptually.
// To run against a live Harper instance, use the auth-middleware pattern below.

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
const AGENT_ID = 'flint';
const PRIV_KEY_PATH = `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;

async function signedFetch(method, path, body) {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  const key = await subtle.importKey('pkcs8', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['sign']);
  const ts = Date.now().toString(), nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  const headers = {
    'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${FLAIR_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

console.log('=== Repro: Transaction commit failed: Resource busy ===\n');
console.log('This test writes a Memory record via PUT.');
console.log('The auth-middleware does tables.Memory.put() after the response.');
console.log('Without the 500ms delay, Harper crashes.\n');

// Rapid-fire 3 PUTs to the same record to maximize race window
for (let i = 0; i < 3; i++) {
  const id = `repro-busy-${i}`;
  const r = await signedFetch('PUT', `/Memory/${id}`, {
    id, agentId: AGENT_ID, content: `Repro test ${i} - ${Date.now()}`,
    durability: 'standard', createdAt: new Date().toISOString(),
  });
  console.log(`PUT ${id}: ${r.status}`);
}

console.log('\nCheck Harper logs for "Transaction commit failed: Resource busy"');
console.log('With 500ms setTimeout workaround, this should succeed.');
console.log('Without it, Harper crashes after 1-3 requests.\n');

// Cleanup
await new Promise(r => setTimeout(r, 2000));
for (let i = 0; i < 3; i++) {
  await signedFetch('DELETE', `/Memory/repro-busy-${i}`);
}
console.log('Cleaned up test records.');
