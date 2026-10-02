# Gauge verdict — Flair PR #2186 at e95aee3c

## Verdict

**APPROVE.** The requested follow-up is implemented and the focused evidence is green. The password warning now describes a safe *way to populate* `FLAIR_ADMIN_PASS` instead of falsely implying that an environment variable by itself avoids shell history, and the deploy example is safe to copy when its URL contains shell metacharacters or an embedded single quote.

The strongest argument against approval is that the complete unit lane could not finish green in this sandbox: listener creation is forbidden, the root step times out on repeated bind failures, and the lane budget then expires. The differential control settles ownership as far as this environment can: every failed PR step also failed on local `origin/main`; there was no PR-only failed step.

## Changes made

- `src/commands/agent.ts:92` defines one corrected warning: use `FLAIR_ADMIN_PASS` without typing its value into a recorded shell line, for example by reading the admin-pass file.
- `src/commands/agent.ts:408` and `src/commands/agent.ts:536` use that warning at the `agent list` and `agent rotate-key` inline-password sites.
- `src/commands/deploy.ts:38` adds POSIX single-argument quoting, using `'\''` for embedded single quotes; `src/commands/deploy.ts:49` applies it to the printed `--target` URL.
- `test/unit/cli-message-flags.test.ts:726` drives both warning sites through the real CLI and rejects the old history claim.
- `test/unit/cli-message-flags.test.ts:760` prints a URL containing both `&` and an embedded single quote, runs the copied line through `/bin/sh` and the real CLI/Commander path, and proves it reaches the Agent read path with the remote credential accepted.
- `.changelog/unreleased/fixed-2123-2124-cli-hint-flags.md:1` now describes both follow-ups.
- `pr-body.new.md` updates the changed PR-body sentences and verification. The original PR body was not modified.
- No CLI-surface snapshot bytes changed; the committed snapshot was left untouched.

## Verification

Focused and touched checks:

```text
bun test test/unit/cli-message-flags.test.ts test/unit/agent-add-adminpass-fallback.test.ts test/unit/cli-target-flag.test.ts
117 pass, 0 fail, 210 expect calls

bun test test/unit-isolated/cli-surface-snapshot.test.ts
3 pass, 0 fail, 14 expect calls

bunx tsc --noEmit -p tsconfig.test.check.json
passed

node scripts/changelog-fragments.mjs check
24 fragments, 24 entries, no stray [Unreleased] entries

git diff --check
passed
```

Complete socket-free lane command on both trees:

```text
bun run test:unit --keep-going

PR tree:     72 passed steps, 15 failed steps, 8 not run (87/95 ran)
origin/main: 75 passed steps, 15 failed steps, 8 not run (90/98 ran)
Exclusive failed steps on either tree: none
```

The control was a local, network-free Git checkout at `1d974235ef508c29e06e248ca3b7fb04b8692c29`. Since killed processes do not print terminal test totals, the sums from completed Bun subprocesses are partial: PR `745 pass / 66 fail`; main `781 pass / 66 fail`.

Both runs also failed the temp-directory guard after killed tests could not perform cleanup.

## Bind-dependent files refused by this sandbox

Observed TCP loopback bind refusals:

- `test/agent-remove-and-grants.test.ts`
- `test/backup-restore.test.ts`
- `test/cli-v2.test.ts`
- `test/key-paths-and-rotation.test.ts`
- `test/unit/backup-admin-pass-file-1910.test.ts`
- `test/unit/cli-memory-add-derived-from.test.ts`
- `test/unit/init-admin-pass-persisted.test.ts`
- `test/unit-isolated/agent-add-existing-id-2126.test.ts`
- `test/unit-isolated/agent-key-format-1736.test.ts`
- `test/unit-isolated/canary-fail-closed-hardening.test.ts`
- `test/unit-isolated/doctor-fix-mcp-pins.test.ts`
- `test/unit-isolated/doctor-fix-pin-hold.test.ts`
- `test/unit-isolated/release-lockstep-scripts.test.ts`
- `test/unit-isolated/upgrade-no-downgrade.test.ts`
- `test/unit-isolated/upgrade-registry-resolution.test.ts`
- `test/unit-isolated/upgrade-rollback-1740-command.test.ts`
- `test/unit-isolated/xaa-jti-replay.test.ts`
- `packages/flair-mcp/test/stdio-skill-surface.test.ts`

Unix-socket binds were also refused in:

- `test/unit/ops-socket-first-start.test.ts`
- `test/unit/init-admin-pass-persisted.test.ts`

Other shared control failures were not caused by this patch: `mcp-enable-cli-output` exited in three existing cases; `release-pack-stage-a1a` hit the host's BSD `find`/Git-fixture constraints; and `replay-store` aborted. Each also occurred on `origin/main`.
