# CLI map

This directory owns CLI behavior, not server resource handlers. `cli.ts` registers
commands and still contains substantial implementation. Search the command name
there, then follow its imports before adding another helper.

| Concern | Existing owners |
|---|---|
| Credential and agent selection | `lib/auth-resolve.ts`, `lib/signing-identity.ts`, `keystore.ts` |
| Client wiring and package pins | `install/clients.ts`, `lib/mcp-spec.ts`, `hook-install.ts` |
| Daemon state and platform lifecycle | `lib/daemon-liveness.ts`, `lib/launchd-management.ts` |
| Doctor / upgrade | `lib/doctor-run.ts`, `doctor-client.ts`, `lib/upgrade-migrations.ts`, `lib/upgrade-exec-path.ts` |
| Deployment / fleet | `deploy.ts`, `fabric-upgrade.ts`, `fleet-verify.ts` |
| REM scheduling and orchestration | `rem/runner.ts`, `rem/scheduler.ts`, `rem/snapshot.ts` |

Extract cohesive command logic into existing owners or a focused module. Root
`tsconfig.check.src.json` checks helpers strictly; `cli.ts` currently uses
`tsconfig.cli.json` with `strict:false`. Do not expand that exception.

For changes shared by init, upgrade, doctor or hooks, inspect all callers of the
owning helper. Preserve explicit flag precedence and the distinction between
requested, installed and running state. Keep instance configuration in its
established custody path rather than deriving a second source of truth.

Validate an extraction with its command tests and both compiler configurations:

```sh
bunx tsc --noEmit -p tsconfig.check.src.json
bunx tsc --noEmit -p tsconfig.cli.json
```

Follow [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the shared test lane. CLI tests
that execute `dist/cli.js` need a current build; source imports alone do not prove
the installed command works. Check packaging when moving imports between CLI,
server and separately published workspace packages.
