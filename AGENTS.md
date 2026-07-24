# AGENTS.md — Flair Repo Map

For humans and agents. Read this first. It takes 60 seconds and prevents hours of wrong conclusions.

---

## 1. CONFIRM YOU ARE CURRENT

**A stale checkout silently invalidates every architectural claim you make.** An agent 488 commits behind reported that federation and memory sync did not exist — while talking to a live 0.28.0 server that had both.

Check your checkout against reality:

```bash
# Against the running server (bootstrap now returns flairVersion — PR #838)
flair status

# Against npm
flair --version
npm view @tpsdev-ai/flair version

# Against origin/main
git fetch origin && git log --oneline origin/main..HEAD   # local ahead
git log --oneline HEAD..origin/main                        # local behind
```

If you are behind, **stop and pull before reasoning about architecture.** The code you are reading may not be the code that is running.

---

## 2. REPO MAP

Server code is **not** under `src/`. This is the single most common wrong assumption.

```
resources/     Server resources (~90 modules). Harper Resource subclasses,
               the MCP tool surface, federation, auth, memory, bootstrap.
               This is where the server lives.

src/           CLI and its helpers. cli.ts is the entry point.
               NOT server code — do not look here for resource handlers.

schemas/       GraphQL table definitions (memory, agent, federation, oauth, …).

test/          Unit, integration, e2e, smoke, compat, and benchmark tests.
               unit/ and unit-isolated/ run without a live Harper.

docs/          User-facing documentation. mcp-clients.md, federation.md,
               deployment.md, auth.md, and others.

specs/         DRAFT planning documents. May not reflect shipped state.
               Do NOT read as current architecture.

packages/      Published sub-packages: flair-client, flair-mcp, flair-bench,
               hermes-flair, n8n-nodes-flair, openclaw-flair,
               langgraph-flair, pi-flair, and bridge adapters.

scripts/       Build, CI, deploy, and operational scripts.

templates/     Launchd/systemd service templates.

types/         Ambient TypeScript declarations (harper.d.ts).

docker/        Dockerfiles for clean-VM and test environments.

DESIGN.md      Architecture invariants — the rules the codebase follows.

CONTRIBUTING.md  PR process, commit conventions, CI gates.

config.yaml    Flair server configuration (port via CLI or HTTP_PORT env).
```

---

## 3. WHERE TO LOOK FIRST

| Question | Start here |
|---|---|
| How does the server work? | `resources/` — pick the file named after the concept |
| How do I run the CLI? | `src/cli.ts` → `flair --help` |
| What are the design rules? | `DESIGN.md` |
| How do I contribute? | `CONTRIBUTING.md` |
| How do I use Flair? | `README.md` → `docs/quickstart.md` |
| What does the data model look like? | `schemas/` |
| Is this spec current? | `specs/` are DRAFT — verify against `resources/` and `DESIGN.md` |
