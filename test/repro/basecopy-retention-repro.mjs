#!/usr/bin/env node
/**
 * flair#1244 — decisive local repro for Harper replication base-copy/resync semantics.
 *
 * QUESTION UNDER TEST
 * When a two-node Harper cluster reconnects after a partition longer than the audit/txn-log
 * retention window, the sender upgrades incremental catch-up to a forced "bounded base-copy
 * resync" (replicationConnection.ts shouldForceBaseCopyForRetention; the incident log line is
 * "forcing a bounded base-copy resync"). The base-copy apply lane stores rows with NO
 * audit/transaction-log entries by design (core Table.ts isCopyApply lane). flair#1244's
 * forensics hypothesized this lane also silently DISCARDS receiver-only rows (rows that exist
 * only on the reconnecting side) — 10 hub-only rows vanished from both nodes with zero delete
 * transactions. This script forces exactly that reconnect shape locally and observes what the
 * base-copy path actually does to receiver-only rows.
 *
 * LANES
 *   basecopy — partition B, write rows only A holds, age past auditRetention, reconnect.
 *              The reconnect MUST log "forcing a bounded base-copy resync" or the lane aborts
 *              as UNPROVEN (the path under test never engaged).
 *   control  — identical flow but reconnect WITHIN retention: incremental catch-up, no forced
 *              base copy expected; distinguishes the base-copy path from normal replication.
 *   residency — the remaining code-anchored suspect after the base-copy disproof (see the
 *              #1244 thread): core Table.ts evaluates TableResource.getResidency on every
 *              write where options.residencyId is undefined (i.e. essentially every ordinary
 *              local write); if the returned list excludes this node's hostname, the LOCAL
 *              record is omitted while writeCommit still writes a NORMAL audited put — no
 *              delete transaction. This lane installs a residency function on node-a via a
 *              tiny component (standing in for the unconfirmed Fabric-side call — no config
 *              surface installs one) that excludes node-a for ids prefixed 'hubonly-'. Rows
 *              written BEFORE the install stand in for the incident's hub-only rows; an
 *              ordinary re-save then triggers the _writeUpdate re-entry.
 *
 *              --residency=record (default) | byid — the two API variants destroy differently,
 *              and the difference is decisive (RecordEncoder.ts recordUpdater: a
 *              record===undefined call never touches the primary store):
 *                record — setResidency(fn(record)): a non-resident write stores a PARTIAL
 *                         record (indexed fields only; even the primary-key field is dropped
 *                         from the value) + INVALIDATED. For an EXISTING row this OVERWRITES
 *                         the full local value — real local destruction via an ordinary
 *                         audited put. The read path then treats the row as remote: with the
 *                         peer up, reads transparently remote-fetch; with the residency
 *                         nodes lacking the row (the incident's hub-only shape), every read
 *                         returns nothing. The #1244-signature candidate.
 *                byid   — setResidencyById(fn(id)): non-resident recordToStore is undefined,
 *                         so a NEW row is simply never stored locally, but an EXISTING row's
 *                         value is left untouched (stale, still readable). This variant
 *                         CANNOT destroy already-stored rows — a useful negative bound.
 *
 *              Thread note (matters for fidelity): the residency function is a per-thread
 *              static; only writes handled by a worker that ran the component see it. The
 *              lane drives the marked writes through a REST resource exported by the same
 *              component, which guarantees the write runs where the function is installed —
 *              the same shape as a component's own writes (flair's Memory writes are
 *              component writes). Ops-API writes served by another thread do NOT engage it
 *              (verified empirically); assertion probes defeat the read path's transparent
 *              remote fetch by probing local state with the peer stopped.
 *
 * INSTRUMENT POSITIVE CONTROL
 * Before partitioning, one canary row is deleted normally and the script asserts the 'delete'
 * entry is visible via read_transaction_log on BOTH nodes. This is load-bearing: it proves a
 * later "zero delete entries" observation is evidence about the mechanism, not a logging gap.
 *
 * ISOLATION / SAFETY
 * - Every node lives in its own mkdtemp tree; HOME and ROOTPATH point INTO that tree. Nothing
 *   under ~/.flair or any production path is read or written.
 * - All ports are OS-assigned free ports (never 9925/9926/9933/1883).
 * - Teardown kills ONLY child PIDs this script spawned (never pkill/pattern kill).
 *
 * USAGE
 *   node test/repro/basecopy-retention-repro.mjs [--lane=basecopy|control|residency|both] [--keep]
 *   (--lane=both runs basecopy + control; residency is run explicitly, with --residency=record|byid)
 *
 *   HARPER_PRO_DIR      dir whose node_modules contains @harperfast/harper-pro (optional; if
 *                       unset the script npm-installs HARPER_PRO_VERSION into a temp sandbox)
 *   HARPER_PRO_VERSION  version to install when HARPER_PRO_DIR is unset (default 5.2.2)
 *
 * Note on fidelity to flair: the repro uses a neutral audited table ("repro"."doc") rather than
 * the flair component. The lane under test is Harper-core: flair's Memory writes terminate in
 * the same Table.put on the same RocksDB-backed audited table and the base-copy receive lane
 * is component-agnostic (core Table.ts, isCopyApply). A neutral schema keeps this script
 * runnable verbatim by Harper upstream.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── knobs ────────────────────────────────────────────────────────────────────
const RETENTION = '1m'; // logging.auditRetention — minutes so aging past it is fast
const RETENTION_MS = 60_000;
const N_BASE = 25; // rows written+replicated before the partition (incl. canary)
const N_PARTITION = 10; // receiver-only rows written while B is down
const ADMIN = { username: 'admin', password: 'repro123' }; // ephemeral throwaway credential
const HARPER_PRO_VERSION = process.env.HARPER_PRO_VERSION ?? '5.2.2';

const args = process.argv.slice(2);
const laneArg = (args.find((a) => a.startsWith('--lane=')) ?? '--lane=both').slice(7);
const KEEP = args.includes('--keep');
// stop    — node-b's process exits and is later restarted (peer-down partition; default)
// suspend — node-b is SIGSTOPped and later SIGCONTed: both processes stay up, the connection
//           wedges and dies by ping timeout, and the resume looks like the incident's
//           ECONNRESET-storm reconnect (no reboot, same connection objects recover)
const PARTITION = (args.find((a) => a.startsWith('--partition=')) ?? '--partition=stop').slice(12);
// record — setResidency(fn(record)); byid — setResidencyById(fn(id)). See the lane doc above.
const RESIDENCY_VARIANT = (args.find((a) => a.startsWith('--residency=')) ?? '--residency=record').slice(12);

// ─── tiny utils ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);
function say(...m) {
	console.log(`[${ts()}]`, ...m);
}
function head(title) {
	console.log(`\n${'═'.repeat(78)}\n[${ts()}] ${title}\n${'═'.repeat(78)}`);
}
let failures = 0;
function check(desc, ok, actual) {
	const mark = ok ? 'PASS' : 'FAIL';
	if (!ok) failures++;
	say(`${mark}  ${desc}${actual !== undefined ? ` — actual: ${actual}` : ''}`);
	return ok;
}

async function getFreePorts(count) {
	const servers = await Promise.all(
		Array.from({ length: count }, () =>
			new Promise((resolve, reject) => {
				const srv = createServer();
				srv.once('error', reject);
				srv.listen(0, '127.0.0.1', () => resolve(srv));
			})
		)
	);
	const ports = servers.map((s) => s.address().port);
	await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
	return ports;
}

import { connect } from 'node:net';
function waitForTcp(port, timeoutMs = 60_000) {
	return waitFor(
		`tcp port ${port} listening`,
		() =>
			new Promise((resolve) => {
				const sock = connect({ port, host: '127.0.0.1' });
				sock.once('connect', () => {
					sock.destroy();
					resolve(true);
				});
				sock.once('error', () => resolve(false));
			}),
		timeoutMs
	);
}

async function waitFor(desc, fn, timeoutMs = 60_000, intervalMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			lastErr = e;
		}
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for: ${desc}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

// ─── harper-pro location ──────────────────────────────────────────────────────
async function resolveHarperPro() {
	let baseDir = process.env.HARPER_PRO_DIR;
	if (!baseDir) {
		baseDir = await mkdtemp(join(tmpdir(), 'hdb-1244-pkg-'));
		say(`Installing @harperfast/harper-pro@${HARPER_PRO_VERSION} into ${baseDir} (one-time, ~500MB)`);
		execFileSync('npm', ['install', `@harperfast/harper-pro@${HARPER_PRO_VERSION}`, '--no-fund', '--no-audit'], {
			cwd: baseDir,
			env: { ...process.env, HOME: baseDir, npm_config_cache: join(baseDir, '.npm') },
			stdio: 'inherit',
		});
	}
	const proDir = join(baseDir, 'node_modules', '@harperfast', 'harper-pro');
	const binPath = join(proDir, 'dist', 'bin', 'harper.js');
	if (!existsSync(binPath)) throw new Error(`harper-pro bin not found at ${binPath}`);
	const version = createRequire(join(proDir, 'package.json'))('./package.json').version;
	const YAML = createRequire(join(proDir, 'package.json'))('yaml');
	say(`Using @harperfast/harper-pro ${version} at ${proDir}`);
	return { binPath, YAML, version };
}

// ─── node lifecycle ───────────────────────────────────────────────────────────
const LIVE = new Set(); // ChildProcess handles we spawned — the ONLY things we ever kill
process.on('exit', () => {
	for (const proc of LIVE) {
		try {
			proc.kill('SIGKILL');
		} catch {}
	}
});
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => process.exit(130));
}

async function makeNode(name, harper) {
	const dir = await mkdtemp(join(tmpdir(), `hdb-1244-${name}-`));
	const [opsPort, httpPort, repPort, mqttPort, mqttsPort] = await getFreePorts(5);
	const node = { name, dir, opsPort, httpPort, repPort, proc: null, harper };
	node.opsUrl = `http://127.0.0.1:${opsPort}`;
	node.wsUrl = `ws://127.0.0.1:${repPort}`;
	const env = {
		...process.env,
		ROOTPATH: dir,
		HOME: dir, // hard isolation: nothing outside this tree
		HDB_ADMIN_USERNAME: ADMIN.username,
		HDB_ADMIN_PASSWORD: ADMIN.password,
		THREADS_COUNT: '1',
		OPERATIONSAPI_NETWORK_PORT: String(opsPort),
		HTTP_PORT: String(httpPort),
	};
	node.env = env;
	say(`[${name}] install → ${dir} (ops:${opsPort} http:${httpPort} repl:${repPort})`);
	execFileSync('node', [harper.binPath, 'install'], { cwd: dir, env, stdio: 'pipe' });
	// Patch the generated config: identity, insecure local replication port, short audit
	// retention, per-node mqtt ports (defaults collide across nodes), drop waf (its re2 native
	// module has no darwin prebuild in the npm package; absent key = component never loads).
	const cfgPath = join(dir, 'harper-config.yaml');
	const cfg = harper.YAML.parse(await readFile(cfgPath, 'utf8'));
	cfg.replication = { hostname: name, url: node.wsUrl, port: repPort, databases: '*' };
	cfg.node = { ...(cfg.node ?? {}), hostname: name };
	cfg.mqtt.network.port = mqttPort;
	cfg.mqtt.network.securePort = mqttsPort;
	cfg.logging.auditLog = true;
	cfg.logging.auditRetention = RETENTION;
	cfg.logging.level = 'info';
	cfg.localStudio = { enabled: false };
	delete cfg.waf;
	await writeFile(cfgPath, harper.YAML.stringify(cfg));
	return node;
}

async function startNode(node) {
	const out = createWriteStream(join(node.dir, 'stdout.log'), { flags: 'a' });
	const proc = spawn('node', [node.harper.binPath, 'run'], { cwd: node.dir, env: node.env });
	proc.stdout.pipe(out);
	proc.stderr.pipe(out);
	node.proc = proc;
	LIVE.add(proc);
	proc.on('exit', () => LIVE.delete(proc));
	await waitFor(
		`${node.name} healthy on ${node.opsUrl}`,
		async () => (await fetch(`${node.opsUrl}/health`, { signal: AbortSignal.timeout(2000) })).status === 200,
		90_000
	);
	say(`[${node.name}] up (pid ${proc.pid})`);
}

async function stopNode(node) {
	const proc = node.proc;
	if (!proc || proc.exitCode !== null) return;
	const exited = new Promise((r) => proc.once('exit', r));
	try {
		proc.kill('SIGCONT'); // a suspended node can't process SIGTERM
	} catch {}
	proc.kill('SIGTERM');
	const t = setTimeout(() => {
		try {
			proc.kill('SIGKILL');
		} catch {}
	}, 10_000);
	await exited;
	clearTimeout(t);
	node.proc = null;
	say(`[${node.name}] stopped`);
}

function nodeLogs(node) {
	let text = '';
	for (const f of [join(node.dir, 'stdout.log'), join(node.dir, 'log', 'hdb.log')]) {
		try {
			text += readFileSync(f, 'utf8');
		} catch {}
	}
	return text;
}

// ─── ops API ──────────────────────────────────────────────────────────────────
async function ops(node, body) {
	const res = await fetch(node.opsUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64'),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!res.ok) {
		const err = new Error(`${body.operation} on ${node.name} → HTTP ${res.status}: ${text.slice(0, 300)}`);
		err.status = res.status;
		throw err;
	}
	return json;
}

const recordCount = async (node) => (await ops(node, { operation: 'describe_table', database: 'repro', table: 'doc' })).record_count;

// POST to a REST resource served on the component/HTTP port (NOT the ops port). REST requests
// are handled by a worker that loaded the components, which is what makes this the right
// vehicle for writes that must engage a component-installed residency function.
async function rest(node, path, body) {
	const res = await fetch(`http://127.0.0.1:${node.httpPort}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64'),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!res.ok) throw new Error(`POST ${path} on ${node.name} → HTTP ${res.status}: ${text.slice(0, 300)}`);
	return json;
}

// Both outbound legs must authenticate before the cluster is usable — a half-connected pair
// (one side looping on 1008 rejects) still replicates everything written on the accepted side
// and looks healthy to a data-only probe.
async function peerConnected(node, peerName) {
	const st = await ops(node, { operation: 'cluster_status' });
	const peer = (st.connections ?? []).find((c) => c.name === peerName);
	return Boolean(peer?.database_sockets?.some((s) => s.database === 'system' && s.connected === true));
}

async function idsPresent(node, ids) {
	const rows = await ops(node, {
		operation: 'search_by_id',
		database: 'repro',
		table: 'doc',
		ids,
		get_attributes: ['id'],
	});
	const found = new Set(rows.filter(Boolean).map((r) => r.id));
	return { found: ids.filter((i) => found.has(i)), missing: ids.filter((i) => !found.has(i)) };
}

async function txnLog(node, from) {
	return ops(node, { operation: 'read_transaction_log', database: 'repro', table: 'doc', from, limit: 1000 });
}

function deletesIn(logEntries, ids) {
	const idSet = new Set(ids);
	return logEntries.filter((e) => e.operation === 'delete' && (e.ids ?? []).some((i) => idSet.has(i)));
}

// ─── cluster assembly ─────────────────────────────────────────────────────────
// `nodes` is caller-owned: nodes are pushed as soon as they exist so the caller's finally
// block can stop/remove them even when cluster formation itself throws.
async function formCluster(harper, nodes) {
	const a = await makeNode('node-a', harper);
	nodes.push(a);
	const b = await makeNode('node-b', harper);
	nodes.push(b);
	await startNode(a);
	await startNode(b);
	// The replication WS server binds after the ops-API health endpoint answers — gate on the
	// actual ports, then require a CLEAN add_node (its partial-success message embeds the error
	// from the add_node_back call to the target; retry until both sides registered).
	await waitForTcp(a.repPort);
	await waitForTcp(b.repPort);
	// add_node must run FROM EACH NODE, and authorization is passed as a PREFORMED
	// 'Basic …' header string. Passing {username,password} loses: the initiator converts the
	// object to a header string for its own hdb_nodes record, but the add_node_back it sends the
	// target carries the RAW object, and the dialer sets headers.Authorization = that value
	// verbatim (createWebSocket) — '[object Object]' — so the target's outbound legs close 1008
	// ("no hdb_nodes entry for IP …": a plain-ws peer with no client cert is only identified by
	// that header). A preformed string is stored verbatim on every record on both sides.
	// node-b is still restarted afterwards so its dialer rebuilds from the final records (live
	// connections cache the record they dialed with).
	for (const [src, dst] of [
		[a, b],
		[b, a],
	]) {
		say(`add_node: registering ${dst.name} from ${src.name} (basic-auth bootstrap, plain ws for a local repro)`);
		await waitFor(
			`clean add_node ${src.name} → ${dst.name}`,
			async () => {
				const res = await ops(src, {
					operation: 'add_node',
					hostname: dst.name,
					url: dst.wsUrl,
					verify_tls: false,
					retain_authorization: true,
					authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64'),
				}).catch((e) => ({ message: `add_node error: ${e.message}` }));
				say('add_node →', JSON.stringify(res).slice(0, 250));
				return /error/i.test(JSON.stringify(res)) ? false : res;
			},
			60_000,
			3000
		);
	}
	say('restarting node-b so its replication dialer picks up the header-form auth record');
	await stopNode(b);
	await startNode(b);
	await waitForTcp(b.repPort);
	await waitFor('node-a outbound leg to node-b connected (system)', () => peerConnected(a, b.name), 90_000, 2000);
	await waitFor('node-b outbound leg to node-a connected (system)', () => peerConnected(b, a.name), 90_000, 2000);
	say('both replication directions authenticated and connected');

	say('creating audited table repro.doc on node-a');
	await ops(a, { operation: 'create_database', database: 'repro' }).catch((e) => {
		if (!/already exists/i.test(e.message)) throw e;
	});
	await ops(a, { operation: 'create_table', database: 'repro', table: 'doc', primary_key: 'id' });
	await waitFor('schema replicated to node-b', () => ops(b, { operation: 'describe_table', database: 'repro', table: 'doc' }).then(() => true).catch(() => false), 60_000);

	const records = Array.from({ length: N_BASE - 1 }, (_, i) => ({ id: `base-${String(i + 1).padStart(3, '0')}`, v: i + 1, wave: 'base' }));
	records.push({ id: 'canary', v: 0, wave: 'canary' });
	await ops(a, { operation: 'upsert', database: 'repro', table: 'doc', records });
	await waitFor(`node-b has all ${N_BASE} base rows`, async () => (await recordCount(b)) === N_BASE, 60_000);
	check(`replication live: both nodes hold ${N_BASE} rows`, (await recordCount(a)) === N_BASE && (await recordCount(b)) === N_BASE, `a=${await recordCount(a)} b=${await recordCount(b)}`);
	return { a, b };
}

async function instrumentPositiveControl(a, b) {
	head('STEP: instrument positive control — a NORMAL delete must appear in read_transaction_log');
	const before = Date.now() - 60_000;
	await ops(a, { operation: 'delete', database: 'repro', table: 'doc', ids: ['canary'] });
	await waitFor('canary delete replicated to node-b', async () => (await recordCount(b)) === N_BASE - 1, 30_000);
	const [la, lb] = [await txnLog(a, before), await txnLog(b, before)];
	const da = deletesIn(la, ['canary']);
	const db = deletesIn(lb, ['canary']);
	check("node-a txn log shows the canary 'delete' entry", da.length === 1, JSON.stringify(da));
	check("node-b txn log shows the canary 'delete' entry (receiver-side deletes ARE audited)", db.length === 1, JSON.stringify(db));
}

// ─── lanes ────────────────────────────────────────────────────────────────────
async function runLane(lane, harper) {
	head(`LANE ${lane.toUpperCase()} — retention ${RETENTION}, ${lane === 'basecopy' ? 'reconnect PAST retention (forced base copy expected)' : 'reconnect WITHIN retention (incremental catch-up expected)'}`);
	const nodes = [];
	try {
		const { a, b } = await formCluster(harper, nodes);
		await instrumentPositiveControl(a, b);

		head(`STEP: partition — ${PARTITION === 'suspend' ? 'suspending (SIGSTOP)' : 'stopping'} node-b`);
		const tPartition = Date.now();
		const bLogMark = nodeLogs(b).length;
		const aLogMark = nodeLogs(a).length;
		if (PARTITION === 'suspend') {
			process.kill(b.proc.pid, 'SIGSTOP');
			say(`[node-b] suspended (pid ${b.proc.pid}) — process alive, silent on the wire`);
		} else {
			await stopNode(b);
		}

		const partIds = Array.from({ length: N_PARTITION }, (_, i) => `part-${String(i + 1).padStart(3, '0')}`);
		if (lane === 'basecopy') {
			// Write LATE in the aging window: the partition-era rows keep fresh audit entries at
			// reconnect (mirrors the incident: lost rows' upsert payloads were still in the retained
			// log) while node-b's replication cursor still ages past retention.
			const preWriteWait = RETENTION_MS * 0.75;
			say(`aging: waiting ${preWriteWait / 1000}s before writing partition-era rows`);
			await sleep(preWriteWait);
		}
		say(`writing ${N_PARTITION} rows on node-a only (node-b is down): ${partIds[0]}..${partIds.at(-1)}`);
		await ops(a, {
			operation: 'upsert',
			database: 'repro',
			table: 'doc',
			records: partIds.map((id) => ({ id, wave: 'partition-era', note: 'exists ONLY on node-a until reconnect' })),
		});
		const expectedTotal = N_BASE - 1 + N_PARTITION;
		check(`node-a now holds ${expectedTotal} rows (only-copy of the ${N_PARTITION})`, (await recordCount(a)) === expectedTotal, await recordCount(a));

		if (lane === 'basecopy') {
			const target = tPartition + RETENTION_MS * 1.25;
			say(`aging: waiting until partition age ${(target - tPartition) / 1000}s > retention ${RETENTION_MS / 1000}s`);
			await sleep(Math.max(0, target - Date.now()));
		} else {
			say('control lane: reconnecting promptly (well within retention)');
			await sleep(5_000);
		}

		head(`STEP: reconnect — ${PARTITION === 'suspend' ? 'resuming (SIGCONT)' : 'restarting'} node-b after ${((Date.now() - tPartition) / 1000).toFixed(0)}s of partition`);
		if (PARTITION === 'suspend') {
			process.kill(b.proc.pid, 'SIGCONT');
			say(`[node-b] resumed (pid ${b.proc.pid})`);
		} else {
			await startNode(b);
		}

		// Convergence: counts stable on both nodes for 3 consecutive polls.
		let stable = 0;
		let last = '';
		await waitFor(
			'cluster convergence (counts stable x3)',
			async () => {
				const cur = `${await recordCount(a).catch(() => '?')}/${await recordCount(b).catch(() => '?')}`;
				stable = cur === last && !cur.includes('?') ? stable + 1 : 0;
				last = cur;
				say(`counts a/b: ${cur}`);
				return stable >= 3;
			},
			180_000,
			4000
		);

		const FORCED = 'forcing a bounded base-copy resync';
		// The direction that tests the hypothesis is node-b SENDING a base copy of `repro` TO
		// node-a (the copy that does NOT mention node-a's receiver-only rows). The sender logs
		// the force warn, so the gate is that exact line in node-b's log naming database repro
		// and peer node-a. Per-database subscription re-requests trail the reconnect by tens of
		// seconds — count stability alone closes the window too early (observed: the system-db
		// force landed 16s after boot, repro later still).
		const bRepro = /Peer node-a requested replication of database repro[\s\S]*?forcing a bounded base-copy resync/;
		if (lane === 'basecopy') {
			await waitFor(
				'node-b forces a base copy of repro TOWARD node-a (the hypothesis direction)',
				() => bRepro.test(nodeLogs(b).slice(bLogMark)),
				180_000,
				3000
			).catch((e) => say(`WARNING: ${e.message} — verdict below reports which directions actually forced`));
			// Let that copy finish and any post-copy disposal run before asserting.
			say('settle: 20s after the hypothesis-direction base copy');
			await sleep(20_000);
		}

		head('ASSERTIONS');
		const bNew = nodeLogs(b).slice(bLogMark);
		const aNew = nodeLogs(a).slice(aLogMark);
		const forcedOnB = bNew.includes(FORCED);
		const forcedOnA = aNew.includes(FORCED);
		for (const [nn, logText, forced] of [
			['node-a', aNew, forcedOnA],
			['node-b', bNew, forcedOnB],
		]) {
			const lines = logText.split('\n').filter((l) => l.includes(FORCED) || l.includes('Replicating all tables to'));
			say(`[${nn}] base-copy log lines since partition:${lines.length ? '\n    ' + lines.join('\n    ') : ' (none)'}`);
		}
		let hypDirection = false;
		if (lane === 'basecopy') {
			const engaged = forcedOnA || forcedOnB;
			hypDirection = bRepro.test(bNew);
			check('forced base-copy path ENGAGED (incident signature present in logs)', engaged, `node-a:${forcedOnA} node-b:${forcedOnB}`);
			check('hypothesis direction ran: node-b base-copied database repro TOWARD node-a', hypDirection);
			if (!hypDirection) {
				say('LANE UNPROVEN for the hypothesis direction: node-a never received a repro base copy lacking its receiver-only rows.');
			}
		} else {
			check('control: NO forced base copy (incremental catch-up served the reconnect)', !forcedOnA && !forcedOnB, `node-a:${forcedOnA} node-b:${forcedOnB}`);
		}

		const [ca, cb] = [await recordCount(a), await recordCount(b)];
		const pa = await idsPresent(a, partIds);
		const pb = await idsPresent(b, partIds);
		say(`record_count: node-a=${ca} node-b=${cb} (expected ${expectedTotal} if nothing is discarded)`);
		say(`partition-era rows on node-a: ${pa.found.length}/${N_PARTITION} present${pa.missing.length ? `, MISSING: ${pa.missing.join(',')}` : ''}`);
		say(`partition-era rows on node-b: ${pb.found.length}/${N_PARTITION} present${pb.missing.length ? `, MISSING: ${pb.missing.join(',')}` : ''}`);

		const [la, lb] = [await txnLog(a, tPartition - 120_000), await txnLog(b, tPartition - 120_000)];
		const delA = deletesIn(la, partIds);
		const delB = deletesIn(lb, partIds);
		say(`'delete' txn-log entries naming partition-era ids: node-a=${delA.length} node-b=${delB.length}`);
		if (delA.length) say('node-a delete entries: ' + JSON.stringify(delA));
		if (delB.length) say('node-b delete entries: ' + JSON.stringify(delB));
		const reloadIsh = (l) => l.filter((e) => /reload/i.test(JSON.stringify(e)));
		say(`txn-log entries mentioning 'reload': node-a=${reloadIsh(la).length} node-b=${reloadIsh(lb).length}`);
		const reloadLog = (t) => t.split('\n').filter((l) => /reload/i.test(l)).slice(0, 5);
		say(`hdb.log lines mentioning 'reload' since partition: node-a=${JSON.stringify(reloadLog(aNew))} node-b=${JSON.stringify(reloadLog(bNew))}`);

		head(`VERDICT — lane ${lane}`);
		const survivedBoth = pa.missing.length === 0 && pb.missing.length === 0 && ca === expectedTotal && cb === expectedTotal;
		const vanished = pa.missing.length === N_PARTITION && pb.found.length === 0;
		if (lane === 'basecopy' && hypDirection) {
			if (vanished && delA.length === 0 && delB.length === 0) {
				say('INCIDENT SIGNATURE REPRODUCED: receiver-only rows discarded by the forced base-copy resync, zero delete transactions.');
			} else if (survivedBoth) {
				say('NOT REPRODUCED under this trigger shape: node-a received a forced base copy of repro that did not mention its receiver-only rows, and those rows SURVIVED on both nodes (per-row copy-apply is additive; nothing was discarded).');
			} else {
				say('PARTIAL / UNEXPECTED outcome — inspect the numbers above.');
			}
		} else if (lane === 'basecopy') {
			say('VERDICT WITHHELD: hypothesis-direction base copy did not run inside the observation window; treat this run as proof-failure, not disproof.');
		} else if (lane === 'control') {
			check('control: rows replicated to node-b and nothing was lost', survivedBoth, `a=${ca} b=${cb} missingA=${pa.missing.length} missingB=${pb.missing.length}`);
		}
		say(`node dirs (${KEEP ? 'kept' : 'removed on exit'}): ${a.dir} ${b.dir}`);
	} finally {
		for (const n of nodes) await stopNode(n).catch(() => {});
		if (!KEEP) for (const n of nodes) await rm(n.dir, { recursive: true, force: true }).catch(() => {});
	}
}

// ─── residency lane ───────────────────────────────────────────────────────────
// The residency-probe component installed on node-a only. It (1) installs the residency
// function at table-registration time — the stand-in for the unconfirmed Fabric-side
// setResidency call — and (2) exports a REST driver so the harness can issue writes that run
// in the component-loaded worker (where the per-thread residency static is actually set).
// Ids prefixed 'hubonly-' reside only on node-b: the list EXCLUDES this node (node-a).
// Everything else returns undefined = default residency (replicate everywhere).
function residencyComponent(variant) {
	const install =
		variant === 'byid'
			? `table.setResidencyById((id) => {
		const list = String(id).startsWith('hubonly-') ? ['node-b'] : undefined;
		console.log('[' + probe + '] getResidencyById(' + JSON.stringify(id) + ') -> ' + JSON.stringify(list));
		return list;
	});`
			: `table.setResidency((record, context) => {
		const id = record ? record.id : undefined;
		const list = String(id).startsWith('hubonly-') ? ['node-b'] : undefined;
		console.log('[' + probe + '] getResidency(id=' + JSON.stringify(id) + ') -> ' + JSON.stringify(list));
		return list;
	});`;
	return `// flair#1244 residency-omission probe (ephemeral repro component; see test/repro/)
const probe = 'residency-probe';
const table = databases && databases.repro && databases.repro.doc;
try {
	if (!table) {
		console.error('[' + probe + '] repro.doc NOT FOUND at load - residency NOT installed');
	} else {
		${install}
		console.log('[' + probe + '] residency function INSTALLED on repro.doc (variant: ${variant})');
	}
} catch (e) {
	console.error('[' + probe + '] install error: ' + e.message);
}

export class ResidencyDriver extends Resource {
	static path = '/residency-driver';
	async post(data) {
		const written = [];
		for (const record of data.records ?? []) {
			await table.put(record);
			written.push(record.id);
		}
		return { ok: true, written, pid: process.pid };
	}
}
`;
}

async function restartNode(node) {
	await stopNode(node);
	await startNode(node);
	await waitForTcp(node.repPort);
}

// Classify what node-a's store actually holds for each id: 'full' (value intact),
// 'partial' (a value came back but its primary-key field is gone — the residency partial
// preserves only indexed fields, and the pk is not among them), 'absent' (no value at all).
// Run with the peer STOPPED, otherwise the read path transparently remote-fetches.
async function classifyRows(node, ids) {
	const rows = await ops(node, { operation: 'search_by_id', database: 'repro', table: 'doc', ids, get_attributes: ['*'] });
	const byId = new Map();
	const unmatched = [];
	for (const r of rows.filter(Boolean)) {
		if (r.id != null) byId.set(r.id, r);
		else unmatched.push(r);
	}
	// search_by_id returns rows positionally for dynamic tables only when found; a partial row
	// (id stripped from the value) cannot be matched back by content, so count them in order.
	const out = {};
	for (const id of ids) {
		if (byId.has(id)) out[id] = { outcome: 'full', row: byId.get(id) };
		else if (unmatched.length) out[id] = { outcome: 'partial', row: unmatched.shift() };
		else out[id] = { outcome: 'absent', row: null };
	}
	return out;
}
const outcomes = (cls) => Object.fromEntries(Object.entries(cls).map(([id, v]) => [id, v.outcome]));

async function runResidencyLane(harper) {
	const variant = RESIDENCY_VARIANT;
	if (!['record', 'byid'].includes(variant)) throw new Error(`unknown --residency variant: ${variant}`);
	head(`LANE RESIDENCY (variant: ${variant}) — residency-omission on ordinary writes (suspect 1 of the #1244 remaining-suspects derivation)`);
	const nodes = [];
	const PRE = ['hubonly-pre-001', 'hubonly-pre-002', 'hubonly-pre-003', 'hubonly-pre-004', 'hubonly-pre-005'];
	const FRESH = ['hubonly-fresh-001', 'hubonly-fresh-002', 'hubonly-fresh-003'];
	const PLAIN = ['plain-101', 'plain-102', 'plain-103', 'plain-104', 'plain-105'];
	const PLAIN_DRIVER = 'plain-201'; // unmarked row written via the SAME driver path (positive control for the vehicle)
	try {
		const { a, b } = await formCluster(harper, nodes);
		await instrumentPositiveControl(a, b);
		const tLane = Date.now();

		head('STEP: pre-phase — write hub-only stand-ins BEFORE any residency exists (they must be ordinarily stored)');
		// resaved:false pre-declares the attribute: on a dynamic table the resource-path write
		// does not add attributes, and an undeclared field would be silently dropped from the
		// stored record (the audit payload keeps it either way).
		await ops(a, {
			operation: 'upsert',
			database: 'repro',
			table: 'doc',
			records: [
				...PRE.map((id) => ({ id, wave: 'pre-residency', v: 1, resaved: false })),
				...PLAIN.map((id) => ({ id, wave: 'pre-residency', v: 1, resaved: false })),
			],
		});
		const afterPre = N_BASE - 1 + PRE.length + PLAIN.length;
		await waitFor(`node-b replicated the pre-phase rows (${afterPre})`, async () => (await recordCount(b)) === afterPre, 60_000);
		check(`pre-phase: both nodes hold ${afterPre} rows`, (await recordCount(a)) === afterPre && (await recordCount(b)) === afterPre, `a=${await recordCount(a)} b=${await recordCount(b)}`);

		head('STEP: install residency on node-a — deploy the probe component and restart (table-registration-time install)');
		const compDir = join(a.dir, 'components', 'residency-probe');
		await mkdir(compDir, { recursive: true });
		await writeFile(join(compDir, 'resources.js'), residencyComponent(variant));
		await restartNode(a);
		await waitFor('replication re-established after node-a restart (a→b)', () => peerConnected(a, b.name), 90_000, 2000);
		await waitFor('replication re-established after node-a restart (b→a)', () => peerConnected(b, a.name), 90_000, 2000);
		const aLogMark = nodeLogs(a).length;
		const installLines = nodeLogs(a)
			.split('\n')
			.filter((l) => l.includes('residency-probe'));
		say(`[node-a] residency-probe log lines: ${JSON.stringify(installLines)}`);
		const installed = installLines.some((l) => l.includes('INSTALLED'));
		check('residency function INSTALLED on node-a (component log line present)', installed);

		let p = await idsPresent(a, PRE);
		check('registration alone destroys nothing: hubonly-pre rows still present on node-a after the residency install', p.missing.length === 0, `present=${p.found.length}/${PRE.length}${p.missing.length ? ` missing=${p.missing.join(',')}` : ''}`);

		head('STEP: trigger — ordinary writes through the component worker (fresh writes + the self-resave _writeUpdate re-entry)');
		const fresh = await rest(a, '/residency-driver', { records: FRESH.map((id) => ({ id, wave: 'post-residency', v: 1, resaved: false })) });
		say(`driver fresh-write response: ${JSON.stringify(fresh)}`);
		const resave = await rest(a, '/residency-driver', {
			records: [
				...PRE.map((id) => ({ id, wave: 'pre-residency', v: 2, resaved: true })),
				{ id: PLAIN_DRIVER, wave: 'post-residency', v: 1, resaved: false },
				{ id: 'plain-101', wave: 'pre-residency', v: 2, resaved: true },
			],
		});
		say(`driver self-resave response: ${JSON.stringify(resave)}`);
		check('driver wrote all marked + control records', fresh.written?.length === FRESH.length && resave.written?.length === PRE.length + 2, `fresh=${JSON.stringify(fresh.written)} resave=${JSON.stringify(resave.written)}`);
		say('settle: 10s for replication of the audited writes to node-b (and for the worker stdout pipe to flush)');
		await sleep(10_000);
		const residencyCalls = nodeLogs(a)
			.slice(aLogMark)
			.split('\n')
			.filter((l) => l.includes('getResidency'));
		// Observation only: console output from inside the write-commit path does not reliably
		// surface in the captured logs. That the function evaluated the marked ids — and returned
		// the node-a-excluding list — is proven by the OUTCOME split instead: hubonly-* and
		// plain-* rows written in the SAME driver call diverge (see the assertions below).
		say(`[node-a] residency function invocation lines captured (informational): ${residencyCalls.length}`);

		head('OBSERVATION (not a gate): reads with the peer UP — the residency read path may transparently remote-fetch');
		let t0 = Date.now();
		const obsA = await idsPresent(a, [...PRE, ...FRESH]);
		say(`node-a search with node-b up: ${obsA.found.length}/${PRE.length + FRESH.length} resolve by id (${Date.now() - t0}ms) — resolving here does NOT prove local storage`);

		head('ASSERT: node-b (the residency list member) received the ordinary audited writes in full');
		const pbPre = await idsPresent(b, PRE);
		const pbFresh = await idsPresent(b, FRESH);
		const bResaved = await ops(b, { operation: 'search_by_id', database: 'repro', table: 'doc', ids: [PRE[0]], get_attributes: ['*'] });
		check('node-b holds ALL hubonly rows (pre + fresh) — they replicated as ordinary writes', pbPre.missing.length === 0 && pbFresh.missing.length === 0, `pre=${pbPre.found.length}/${PRE.length} fresh=${pbFresh.found.length}/${FRESH.length}`);
		check('node-b sees the resave content (resaved flag) — the re-entry write was an ordinary replicated put', bResaved[0]?.resaved === true, JSON.stringify(bResaved[0]));

		head('STEP: stop node-b, then probe node-a LOCAL state (defeats the transparent remote fetch)');
		await stopNode(b);
		t0 = Date.now();
		const clsPre = await classifyRows(a, PRE);
		const clsFresh = await classifyRows(a, FRESH);
		const clsPlain = await classifyRows(a, [...PLAIN, PLAIN_DRIVER]);
		say(`local probes took ${Date.now() - t0}ms`);
		say(`node-a local state, pre-residency hubonly rows: ${JSON.stringify(outcomes(clsPre))}`);
		say(`  sample stored value for ${PRE[0]}: ${JSON.stringify(clsPre[PRE[0]].row)}`);
		say(`node-a local state, post-install hubonly rows: ${JSON.stringify(outcomes(clsFresh))}`);
		say(`node-a local state, unmarked rows: ${JSON.stringify(outcomes(clsPlain))}`);
		const caFinal = await recordCount(a);
		say(`node-a record_count=${caFinal} (a destroyed-but-stubbed row still counts; the incident's counts were index/vector-based)`);
		const preDestroyed = PRE.filter((id) => clsPre[id].outcome !== 'full');
		const freshNotStored = FRESH.filter((id) => clsFresh[id].outcome !== 'full');
		const plainIntact = [...PLAIN, PLAIN_DRIVER].filter((id) => clsPlain[id].outcome === 'full');
		if (variant === 'record') {
			check('(a) INCIDENT SIGNATURE: the ordinary re-save DESTROYED the pre-existing local values on node-a (partial/absent, not full)', preDestroyed.length === PRE.length, JSON.stringify(outcomes(clsPre)));
		} else {
			check('(a/byid) the byid variant left pre-existing local values in place (recordUpdater never touches the store for record===undefined) — expected: NO destruction', preDestroyed.length === 0, JSON.stringify(outcomes(clsPre)));
			const stale = clsPre[PRE[0]].row;
			check('(a2/byid) ...and the surviving local value is the STALE pre-resave one (v=1, resaved=false) — the resave was audit-only locally', stale?.v === 1 && stale?.resaved === false, JSON.stringify(stale));
		}
		check(`(a3) hubonly rows first written AFTER the install were never fully stored on node-a (${variant === 'record' ? 'partial stub only' : 'no store write at all'})`, freshNotStored.length === FRESH.length, JSON.stringify(outcomes(clsFresh)));
		const plainResavedRow = clsPlain['plain-101'].row;
		check('(c) unmarked rows untouched on node-a (incl. the driver-written one and the resaved control, which carries its update)', plainIntact.length === PLAIN.length + 1 && plainResavedRow?.resaved === true && plainResavedRow?.v === 2, `full=${plainIntact.length}/${PLAIN.length + 1} plain-101=${JSON.stringify(plainResavedRow)}`);

		head('ASSERT: transaction log — ordinary puts, ZERO deletes (the instrument positive-control above proves deletes DO log)');
		const la = await txnLog(a, tLane - 120_000);
		const hubIds = [...PRE, ...FRESH];
		const delEntries = deletesIn(la, hubIds);
		const putEntries = la.filter((e) => e.operation !== 'delete' && (e.ids ?? []).some((i) => hubIds.includes(i)));
		const resaveEntries = putEntries.filter((e) => (e.records ?? []).some((r) => r && r.resaved === true));
		say(`txn-log entries naming hubonly ids: non-delete=${putEntries.length} delete=${delEntries.length}; operations=${JSON.stringify([...new Set(putEntries.map((e) => e.operation))])}`);
		if (delEntries.length) say(`delete entries: ${JSON.stringify(delEntries)}`);
		check('(b) ZERO delete transactions name any hubonly id', delEntries.length === 0, String(delEntries.length));
		check('(b2) the destruction-triggering re-save is an ORDINARY audited entry carrying the full record payload', resaveEntries.length >= 1 && resaveEntries.some((e) => (e.records ?? []).some((r) => r && r.id === PRE[0] && r.resaved === true)), JSON.stringify(resaveEntries.at(-1)?.records?.find((r) => r?.id === PRE[0]) ?? null));
		const restorePayload = putEntries
			.flatMap((e) => e.records ?? [])
			.filter((r) => r && r.id === PRE[0])
			.at(-1);
		say(`restore payload captured from the txn log: ${JSON.stringify(restorePayload)}`);

		head('STEP: restore — remove the residency component, restart node-a, re-upsert the audit payload (node-b still down: reads are provably local)');
		await rm(compDir, { recursive: true, force: true });
		await restartNode(a);
		await ops(a, { operation: 'upsert', database: 'repro', table: 'doc', records: [restorePayload] });
		const restored = await ops(a, { operation: 'search_by_id', database: 'repro', table: 'doc', ids: [PRE[0]], get_attributes: ['*'] });
		check('(d) restore from the transaction-log payload recovers the FULL row locally', restored[0]?.id === PRE[0] && restored[0]?.resaved === true && restored[0]?.v === 2, JSON.stringify(restored[0]));

		head(`VERDICT — lane residency, variant ${variant}`);
		const common =
			installed &&
			p.missing.length === 0 && // present after registration
			freshNotStored.length === FRESH.length &&
			delEntries.length === 0 &&
			resaveEntries.length >= 1 &&
			plainIntact.length === PLAIN.length + 1 &&
			restored[0]?.id === PRE[0];
		if (variant === 'record') {
			if (common && preDestroyed.length === PRE.length) {
				say('INCIDENT SIGNATURE REPRODUCED (record variant): with a setResidency function installed whose list excludes this node, an ORDINARY write (a self-resave) destroyed the pre-existing local values (partial/invalidated stub; reads return nothing once the residency peers cannot serve the row) with ZERO delete transactions; the destroying write is itself a normal audited put; unmarked rows are untouched; and the row is fully recoverable from its transaction-log payload. This demonstrates mechanism SUFFICIENCY for the #1244 observables. Whether anything installs such a residency function on the incident hub (the Fabric-side trigger question) remains open and is not answerable from this harness.');
			} else {
				say('NOT REPRODUCED (record variant): one or more signature components did not fire — see the failed checks above.');
			}
		} else {
			if (common && preDestroyed.length === 0) {
				say('BYID VARIANT BOUND CONFIRMED: setResidencyById omission cannot destroy an already-stored local row (the record===undefined write never touches the primary store — it only prevents NEW local storage and writes the audit entry). If the incident mechanism is residency omission, it must be the record-based setResidency variant (or the rows must have been first written AFTER the residency install).');
			} else {
				say('UNEXPECTED byid outcome — see the failed checks above.');
			}
		}
		say(`node dirs (${KEEP ? 'kept' : 'removed on exit'}): ${a.dir} ${b.dir}`);
	} finally {
		for (const n of nodes) await stopNode(n).catch(() => {});
		if (!KEEP) for (const n of nodes) await rm(n.dir, { recursive: true, force: true }).catch(() => {});
	}
}

// ─── main ─────────────────────────────────────────────────────────────────────
const harper = await resolveHarperPro();
const lanes = laneArg === 'both' ? ['basecopy', 'control'] : [laneArg];
for (const lane of lanes) {
	if (!['basecopy', 'control', 'residency'].includes(lane)) throw new Error(`unknown lane: ${lane}`);
	if (lane === 'residency') await runResidencyLane(harper);
	else await runLane(lane, harper);
}
head(`DONE — ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
