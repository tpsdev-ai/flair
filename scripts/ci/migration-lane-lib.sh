#!/usr/bin/env bash
# migration-lane-lib.sh — shared bash helpers for the migration CI lanes
# (downgrade-and-revert, snapshot-restore-drill, and the upgrade-lane
# migration assertions bolted onto `upgrade-smoke` in test.yml).
#
# Governed by ~/ops/FLAIR-CI-FOUNDATION.md §2 / ~/ops/FLAIR-MIGRATION-SAFETY.md
# / ~/ops/FLAIR-ZERO-TOUCH-UPGRADE.md. Meant to be `source`d, not executed —
# every function below is a bounded-retry (never single-shot) verification
# primitive, per flair#691's lesson (a single post-restart status check races
# boot on a slow CI runner) generalized to every lane that polls Harper after
# a boot/restart/kill.
#
# All functions read simple positional args (no associative arrays, for
# `bash -n`/portability) and print progress to stdout so a CI log is
# self-explanatory without a second evidence-gathering pass. On a genuine
# timeout, each polling function prints the last-observed state/response
# itself — callers additionally call `dump_migration_diagnostics` (below) in
# an `if: failure()` step so the *files* survive as an uploaded artifact too.
#
# These constants MUST match resources/migrations/synthetic-test-migration.ts
# exactly — CI shell can't `import` a TS module, so this is a deliberate,
# documented duplication (same idiom test/integration/migrations-*.test.ts
# uses for the same reason).
SYNTHETIC_MIGRATION_ID="synthetic-ci-schema-stamp"
RESERVED_TEST_AGENT_ID="__flair_migration_synthetic_test_agent__"
SYNTHETIC_TARGET_MARKER="${SYNTHETIC_MIGRATION_ID}-done"

# ─── Generic bounded-retry HTTP reachability check ─────────────────────────
# Replaces every "curl once right after restart" pattern (the flair#691
# class of bug). Polls every 2s until `curl -sf` against `$1` succeeds or
# `$2` seconds elapse.
wait_for_http_ok() {
  local url="$1" timeout_s="${2:-60}" label="${3:-$url}"
  local deadline=$((SECONDS + timeout_s))
  local attempt=0
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    if curl -sf -o /dev/null --max-time 5 "$url"; then
      echo "[wait_for_http_ok] ${label} reachable after ${attempt} attempt(s) (~$((SECONDS - (deadline - timeout_s)))s)"
      return 0
    fi
    sleep 2
  done
  echo "::error::[wait_for_http_ok] ${label} did not become reachable within ${timeout_s}s (${url})"
  return 1
}

# ─── Inverse: bounded-retry wait for a URL to stop answering ───────────────
# Used after `flair stop`/a SIGTERM kill (which return/land asynchronously —
# see startFlairProcess's own comment on this in src/cli.ts) to confirm the
# OLD process has genuinely exited before a caller starts a new one against
# the same port/data dir. Bounded, not a fixed `sleep N` guess.
wait_for_http_down() {
  local url="$1" timeout_s="${2:-30}" label="${3:-$url}"
  local deadline=$((SECONDS + timeout_s))
  local attempt=0
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    if ! curl -sf -o /dev/null --max-time 3 "$url" 2>/dev/null; then
      echo "[wait_for_http_down] ${label} stopped answering after ${attempt} attempt(s)"
      return 0
    fi
    sleep 1
  done
  echo "::error::[wait_for_http_down] ${label} was still answering after ${timeout_s}s — process may not have exited"
  return 1
}

# ─── Bounded-retry `flair status` check ────────────────────────────────────
# THE #691 FIX SHAPE: `$1` is the flair invocation (e.g. "node dist/cli.js"),
# `$2` the port, `$3` the timeout in seconds. Polls until `status` reports
# "running" and never treats a transient "unreachable" as final until the
# deadline — exactly the bounded-retry / waitForHealth pattern
# test/helpers/harper-lifecycle.ts uses for the bun-test harness, ported to
# the real installed CLI's own `status` subcommand for these npm-install-path
# lanes.
wait_for_flair_status_running() {
  local flair_cmd="$1" port="$2" timeout_s="${3:-90}"
  local deadline=$((SECONDS + timeout_s))
  local attempt=0
  local status_out=""
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    status_out=$($flair_cmd status --port "$port" 2>&1 || true)
    if echo "$status_out" | grep -qi "unreachable"; then
      : # still coming up — keep polling
    elif echo "$status_out" | grep -qi "running"; then
      echo "[wait_for_flair_status_running] running after ${attempt} attempt(s)"
      echo "$status_out"
      return 0
    fi
    sleep 2
  done
  echo "::error::[wait_for_flair_status_running] never reported 'running' within ${timeout_s}s — last output:"
  echo "$status_out"
  return 1
}

# ─── HealthDetail fetch (admin Basic auth) ─────────────────────────────────
fetch_health_detail() {
  local base_url="$1" admin_pass="$2"
  curl -sf -u "admin:${admin_pass}" --max-time 10 "${base_url}/HealthDetail"
}

# ─── Bounded-retry: wait for a named migration to reach an exact state ─────
# `$4` is one of the resources/migrations/types.ts MigrationState values
# ("running" | "completed" | ...). Treats "halted"/"failed" as an immediate
# terminal failure (never silently keeps polling past a real halt) UNLESS
# that IS the target state.
wait_for_migration_state() {
  local base_url="$1" admin_pass="$2" migration_id="$3" target_state="$4" timeout_s="${5:-120}"
  local deadline=$((SECONDS + timeout_s))
  local attempt=0
  local detail_json="" state=""
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    detail_json=$(fetch_health_detail "$base_url" "$admin_pass" 2>/dev/null || echo "")
    state=$(MIG_ID="$migration_id" node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          const m = (j.migrations && j.migrations.migrations || []).find(x => x.id === process.env.MIG_ID);
          process.stdout.write(m ? m.state : "");
        } catch { process.stdout.write(""); }
      });
    ' <<< "$detail_json" 2>/dev/null || echo "")
    if [[ "$state" == "$target_state" ]]; then
      echo "[wait_for_migration_state] '${migration_id}' reached '${target_state}' after ${attempt} attempt(s)"
      return 0
    fi
    if [[ "$state" == "halted" || "$state" == "failed" ]]; then
      echo "::error::[wait_for_migration_state] '${migration_id}' entered terminal state '${state}' while waiting for '${target_state}'"
      echo "$detail_json"
      return 1
    fi
    sleep 2
  done
  echo "::error::[wait_for_migration_state] '${migration_id}' never reached '${target_state}' within ${timeout_s}s (last observed state: '${state:-<none>}')"
  echo "$detail_json"
  return 1
}

# ─── Bounded-retry, two-phase: wait for a migration to be genuinely
# mid-flight (state=running AND rowsDone>0 AND rowsRemaining>0) ────────────
# Mirrors test/integration/migrations-resume-after-kill.test.ts's proven
# two-phase pattern: first wait for "running" (a generous deadline — the
# deferred boot-keyed start can take tens of seconds), THEN catch a
# mid-flight sample inside a second, tighter deadline. FAILS LOUD (not a
# silent pass) if "completed" is observed before mid-flight was ever caught
# — that means the batch delay/row count is mistuned for this runner, which
# is a real signal to widen it, not something to swallow.
wait_for_migration_mid_flight() {
  local base_url="$1" admin_pass="$2" migration_id="$3" running_timeout_s="${4:-150}" midflight_timeout_s="${5:-90}"

  if ! wait_for_migration_state "$base_url" "$admin_pass" "$migration_id" "running" "$running_timeout_s"; then
    return 1
  fi

  local deadline=$((SECONDS + midflight_timeout_s))
  local attempt=0
  local detail_json="" result=""
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    detail_json=$(fetch_health_detail "$base_url" "$admin_pass" 2>/dev/null || echo "")
    result=$(MIG_ID="$migration_id" node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          const m = (j.migrations && j.migrations.migrations || []).find(x => x.id === process.env.MIG_ID);
          if (!m) { process.stdout.write("missing"); return; }
          if (m.state === "completed") { process.stdout.write("completed"); return; }
          if ((m.state === "halted" || m.state === "failed")) { process.stdout.write("terminal:" + m.state + ":" + (m.reason || "")); return; }
          if (m.state === "running" && m.rowsDone > 0 && m.rowsRemaining > 0) {
            process.stdout.write("midflight:" + m.rowsDone + ":" + m.rowsRemaining);
            return;
          }
          process.stdout.write("waiting:" + m.state);
        } catch { process.stdout.write("parse-error"); }
      });
    ' <<< "$detail_json" 2>/dev/null || echo "")
    case "$result" in
      midflight:*)
        echo "[wait_for_migration_mid_flight] caught '${migration_id}' mid-flight after ${attempt} attempt(s): ${result#midflight:}"
        return 0
        ;;
      completed)
        echo "::error::[wait_for_migration_mid_flight] '${migration_id}' completed before a mid-flight state was ever observed — the batch delay / row count is mistuned for this runner (widen FLAIR_MIGRATION_TEST_BATCH_DELAY_MS or increase the seeded row count)"
        return 1
        ;;
      terminal:*)
        echo "::error::[wait_for_migration_mid_flight] '${migration_id}' ${result#terminal:} while waiting to catch it mid-flight"
        echo "$detail_json"
        return 1
        ;;
    esac
    sleep 0.5
  done
  echo "::error::[wait_for_migration_mid_flight] never observed a mid-flight state for '${migration_id}' within ${midflight_timeout_s}s of reaching 'running' (last: ${result:-<none>})"
  echo "$detail_json"
  return 1
}

# ─── Ledger (OrgEvent) content-hash envelope check ─────────────────────────
# Reads the migration's ledger row via the ops API (search_by_value on
# OrgEvent.refId — same raw-ops read path downgrade-boot.test.ts /
# federation-mixed-version.test.ts use, version-stable and independent of
# either build's CLI/REST auth resolution). Prints the parsed `detail` blob
# (structural-only per the Sherlock-ratified ledger shape) and returns 0 only
# when `hashEnvelopeMatch === true` (invariant IV's completion-gate proof).
check_ledger_hash_envelope() {
  local ops_url="$1" admin_pass="$2" migration_id="$3"
  local body resp
  body=$(MIG_ID="$migration_id" node -e 'process.stdout.write(JSON.stringify({operation:"search_by_value",database:"flair",table:"OrgEvent",search_attribute:"refId",search_value:process.env.MIG_ID,get_attributes:["*"]}))')
  resp=$(curl -sf -u "admin:${admin_pass}" -X POST -H "Content-Type: application/json" -d "$body" --max-time 10 "${ops_url}/")
  MIG_ID="$migration_id" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      let rows;
      try { rows = JSON.parse(d); } catch (e) { console.error("could not parse ledger search response: " + e.message); process.exit(2); }
      if (!Array.isArray(rows)) rows = [rows];
      if (rows.length === 0) { console.error("no ledger OrgEvent found for migration " + process.env.MIG_ID); process.exit(2); }
      const evt = rows[rows.length - 1];
      let detail;
      try { detail = JSON.parse(evt.detail); } catch (e) { console.error("could not parse ledger detail JSON: " + e.message); process.exit(2); }
      console.log(JSON.stringify(detail, null, 2));
      if (detail.hashEnvelopeMatch === true) process.exit(0);
      console.error("hashEnvelopeMatch !== true (got: " + JSON.stringify(detail.hashEnvelopeMatch) + ")");
      process.exit(1);
    });
  ' <<< "$resp"
}

# ─── ops API: exact row read-back for an agent (version-stable path) ───────
# Same rationale as test/compat/downgrade-boot.test.ts's fetchAgentMemories:
# a raw ops search_by_value doesn't depend on either build's `flair memory
# search` CLI/REST auth resolution (which has genuinely differed across
# versions) — the honest "did the bytes survive" check.
fetch_agent_memories_json() {
  local ops_url="$1" admin_pass="$2" agent_id="$3"
  local body
  body=$(AGENT_ID="$agent_id" node -e 'process.stdout.write(JSON.stringify({operation:"search_by_value",database:"flair",table:"Memory",search_attribute:"agentId",search_value:process.env.AGENT_ID,get_attributes:["*"]}))')
  curl -sf -u "admin:${admin_pass}" -X POST -H "Content-Type: application/json" -d "$body" --max-time 15 "${ops_url}/"
}

# ─── Self-diagnosing failure dump ───────────────────────────────────────────
# Writes everything a maintainer would otherwise have to re-derive by hand
# into `$4/diagnostics.txt` (+ a copy of Harper's own on-disk log, which
# `flair start`/`restart` spawns with stdio:"ignore" on Linux — Harper still
# writes its OWN internal log to <dataDir>/log/hdb.log regardless, per
# docs/troubleshooting.md, so that file — not the CLI wrapper's stdout — is
# the real source of Harper-internal diagnostics). Best-effort: never throws,
# so a diagnostics failure can't mask the real test failure that triggered it.
dump_migration_diagnostics() {
  local data_dir="$1" base_url="$2" admin_pass="$3" out_dir="$4"
  mkdir -p "$out_dir"
  {
    echo "== HealthDetail (${base_url}/HealthDetail) =="
    fetch_health_detail "$base_url" "$admin_pass" 2>&1 || echo "(HealthDetail unreachable)"
    echo
    echo "== migrations state file (${data_dir}/.migrations/state.json) =="
    cat "${data_dir}/.migrations/state.json" 2>&1 || echo "(state.json absent)"
    echo
    echo "== migrations snapshot dir listing (${data_dir}/.migrations/snapshots/) =="
    ls -la "${data_dir}/.migrations/snapshots/" 2>&1 || echo "(snapshots dir absent)"
    echo
    echo "== hdb.log tail (last 400 lines of ${data_dir}/log/hdb.log) =="
    tail -n 400 "${data_dir}/log/hdb.log" 2>&1 || echo "(hdb.log absent)"
  } > "${out_dir}/diagnostics.txt" 2>&1 || true
  cp "${data_dir}/log/hdb.log" "${out_dir}/hdb.log" 2>/dev/null || true
  cp "${data_dir}/.migrations/state.json" "${out_dir}/migrations-state.json" 2>/dev/null || true
  echo "[dump_migration_diagnostics] wrote diagnostics to ${out_dir}"
}
