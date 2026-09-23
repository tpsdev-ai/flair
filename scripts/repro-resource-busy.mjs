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
 *
 * USAGE (flair#1855). Every request this script sends is SIGNED, so it needs an
 * explicit identity: `FLAIR_AGENT_ID` or `--agent <id>`. It refuses without one.
 * It used to sign as a hardcoded 'flint' from one fixed legacy key path — i.e. as
 * a principal the caller never chose. Key resolution and signing are now the
 * client's own, shared via scripts/lib/flair-signing.mjs.
 *
 *   FLAIR_AGENT_ID=anvil node scripts/repro-resource-busy.mjs
 *   node scripts/repro-resource-busy.mjs --agent anvil
 */

import { loadPrivateKey, signedFetch } from './lib/flair-signing.mjs';

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';

// Identity (flair#1855): the caller chooses it. There is no default.
const args = process.argv.slice(2);
const agentFlagIndex = args.indexOf('--agent');
let agentFromFlag;
if (agentFlagIndex !== -1) {
  agentFromFlag = args[agentFlagIndex + 1];
  if (agentFromFlag === undefined || agentFromFlag === '' || agentFromFlag.startsWith('--')) {
    console.error('--agent requires a value');
    process.exit(1);
  }
}
const AGENT_ID = process.env.FLAIR_AGENT_ID || agentFromFlag;
if (!AGENT_ID) {
  console.error(
    'refusing to run: no agent identity. Set FLAIR_AGENT_ID or pass --agent <id>. ' +
      'Signing as a default identity would act as a principal the caller did not choose (flair#1855).',
  );
  process.exit(1);
}

// Fail early and clearly if there is no key, before sending anything.
try {
  await loadPrivateKey(AGENT_ID);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

console.log('=== Repro: Transaction commit failed: Resource busy ===\n');
console.log('This test writes a Memory record via PUT.');
console.log('The auth-middleware does tables.Memory.put() after the response.');
console.log('Without the 500ms delay, Harper crashes.\n');

// Rapid-fire 3 PUTs to the same record to maximize race window
for (let i = 0; i < 3; i++) {
  const id = `repro-busy-${i}`;
  const r = await signedFetch({
    agentId: AGENT_ID,
    url: FLAIR_URL,
    method: 'PUT',
    path: `/Memory/${id}`,
    body: { id, agentId: AGENT_ID, content: `Repro test ${i} - ${Date.now()}`, durability: 'standard', createdAt: new Date().toISOString() },
    raw: true,
  });
  console.log(`PUT ${id}: ${r.status}`);
}

console.log('\nCheck Harper logs for "Transaction commit failed: Resource busy"');
console.log('With 500ms setTimeout workaround, this should succeed.');
console.log('Without it, Harper crashes after 1-3 requests.\n');

// Cleanup
await new Promise(r => setTimeout(r, 2000));
for (let i = 0; i < 3; i++) {
  await signedFetch({ agentId: AGENT_ID, url: FLAIR_URL, method: 'DELETE', path: `/Memory/repro-busy-${i}`, raw: true });
}
console.log('Cleaned up test records.');
