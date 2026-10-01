# flair#2059 sweep — every sentence this PR adds or changes

Scanned: prose in `git diff origin/main...HEAD` (module/function docs, inline
comments, operator strings, boot lines, changelog fragment, test names and
comments) and the PR body. Each entry is the sentence and the call: `true`
(verified against the code / a live run), `fixed` (was over-broad or false; the
edit is in this round), or `n/a` (not a claim).

## `resources/multi-worker-guard.ts`

- "Flair runs one Harper worker thread by default." — true. Both shipped launch
  paths pin `THREADS_COUNT=1`.
- "a per-worker embedding engine and per-worker BM25 index copies today, with the
  in-process caches and rate limiters not yet enumerated" — true (#2052 audit).
- "the XAA token path keeps its own `jti` single-use record … until flair#2073" —
  true (get-then-put over two workers; #2073 routes it through the shared record).
- "It reads the worker count ONCE per worker module instance" — true (memoised).
- "The count is `server.workerCount`, Harper's per-thread value; where that is not
  a positive integer (on the main thread alongside worker threads it is
  `undefined`), the count falls back to Harper's effective configured count,
  `server.config.threads.count`." — fixed (new this round) and true: measured a
  live Harper 5.2.8 with `THREADS_COUNT=1` and `=2`; `server.config.threads.count`
  read 1 and 2 on the worker threads.
- "A count that is not a positive integer on either path — including a getter that
  throws — is UNKNOWN, which is refused." — true (`readPositiveInteger`; unit
  cases for 1.5, absent, throwing).
- "the refusal lands before the method allowlist, before Harper's `authentication`
  and before any flair handler on the default chain" — true (real Harper:
  `TRACE /Memory` → 503, `GET /Memory` with no credential → 503).
- "flair's mounts declare `after: MULTI_WORKER_GUARD_HTTP_NAME` … and
  oauth-wellknown.ts registers this same guard function as a runFirst mount at
  the plugin's well-known paths" — true (both mechanisms; `oauth-wellknown.ts`
  registers the `after` handlers and the `runFirst` guard mounts).
- "Under it requests serve; the boot line is still emitted and /Health stays
  non-OK, naming the opt-in." — true (unit + real-Harper opt-in: 200, /Health
  503 `unsafe-opt-in`).
- "With one worker nothing changes: no boot line, and /Health is unchanged." —
  true (unit: field omitted; real Harper: 200).
- "Harper starts workers while `i < count`, so a value that is not an integer
  (1.5) starts more workers than it names" — true (socketRouter.js loop).
- `workerCountLabel` "the worker count is unreadable" / `worker count=N` — fixed
  (the label named only `server.workerCount`, which is no longer the sole source).

## `resources/health.ts`

- "On one worker the field is omitted and this endpoint is byte-identical to
  before the guard." — true (real Harper at 1 worker: 200, no `multiWorker`).

## `resources/oauth-wellknown.ts`

- "flair's document mounts here are ordered `after` the multi-worker guard … the
  guard is also registered as a runFirst mount at each path, ahead of the
  plugin's handler." — true (unit pins both registrations; real Harper: the
  plugin's `/.well-known/jwks.json` answers 503 on the refused instance and 200
  on the one-worker control).
- "flag ON with the plugin component NOT declared serves neither document (404)"
  — true (pre-existing gap named this round-3; unchanged).

## `src/lib/doctor-run.ts`

- "A 2xx is reaching. A 503 is reaching ONLY when its `multiWorker` field names
  the refusal … Any other non-2xx is not reaching." — fixed (was "A 2xx is
  Flair … a 503 is Flair ONLY when …"; a bare 2xx is any responder, and the check
  reads only a recognized state field) and true (`interpretFlairHealth`).
- "A 2xx with a malformed `multiWorker` is `unknown`, never serving; a 503 with
  no recognized field is not reaching, so its worker check is skipped rather than
  blocking." — fixed (the old text said a malformed field is unknown, never
  serving, without the non-2xx skip) and true.
- "An ABSENT field (undefined/null) is a serving instance" — true.
- "Anything else — a non-object, or an object with no recognized state — is
  UNKNOWN, never promoted to serving." — true (`readWorkerThreadsObservation`).

## `src/commands/doctor.ts`

- "Must return true ONLY for a recognized /Health: a 2xx, OR a 503 whose body
  carries the recognized `multiWorker` refusal field." — fixed (was "a Flair
  /Health: a 200 OK, OR …"; any 2xx is accepted, and the 503 needs only the
  recognized field) and true.
- "A 2xx body's `multiWorker` field becomes the worker-threads observation … A
  503 is reached only when that field names the refusal; any other 503 is not
  reached, so its worker check is skipped." — fixed (qualifies the malformed
  wording) and true.

## `.changelog/unreleased/security-multi-worker-refusal.md`

- "With more than one worker — the count read from `server.workerCount`, or
  Harper's effective configured count (`server.config.threads.count`) where that
  is not a positive integer — every worker now logs one named error, and the
  instance refuses before dispatch with one named 503: ahead of the method
  allowlist on the default chain, and ahead of the handler on each `urlPath`
  mount." — fixed (the count source) and true (real Harper 2 workers: every
  probed route 503).
- "A count that is not a positive integer on either path … is UNKNOWN and
  refused." — true.
- "Workers stay up in the refused state; nothing throws during boot." — true.
- "One worker is unchanged: no new log line and /Health is identical." — true.
- "the instance serves, the opt-in is still logged and `/Health` stays non-OK —
  and it is never set by any flair launch path." — true.

## Tests

- `test/unit-isolated/multi-worker-refusal-2059.test.ts` credential comment —
  fixed: it claimed a "real before-auth assertion"; it invokes the captured guard
  entry with a stub next layer, so it proves the guard does not read a credential,
  not the whole chain.
- `test/unit-isolated/oauth-wellknown-guard-2059.test.ts` describe title —
  fixed: "ordered ahead of the guard" reversed the order; the mounts run after
  the guard.
- `test/integration/multi-worker-refusal-2059.test.ts` Linux-gate comment —
  fixed: it claimed the main thread serves alone with `server.workerCount` reading
  1; the gate is that the multi-worker dispatch is not observable off Linux.

## Deliberately not changed

- `src/commands/doctor.ts` "responds to /Health with 200 OK" port-discovery
  comments and the Darwin wording in `test/helpers/harper-lifecycle.ts` /
  `test/integration/federation-instance-create-race-1897.test.ts` are outside
  this PR's changed lines (named as follow-ups).
