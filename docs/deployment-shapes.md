# Which Flair deployment shape are you in?

Flair runs in one of three shapes. Pick yours and follow only that path.

| You want to... | Shape | Start here |
|---|---|---|
| Run Flair on your own machine or VPS. `flair init` installs Harper, creates your agent identity, and you're running. | **Standalone local** | [standalone-local.md](standalone-local.md) |
| Run Flair on [Harper Fabric](https://www.harperdb.io/) — managed hosting, multi-region replication, no shell on the node. You deploy a component; agents connect over HTTPS. | **Hosted on Fabric** | [quickstart-fabric.md](quickstart-fabric.md) (new-user URL) · [hosted-on-fabric.md](hosted-on-fabric.md) |
| Load Flair into a Harper instance you already run. In-process calls — no HTTP, no second process, no key to distribute. Over HTTP it is one memory API among many. | **Embedded in a Harper app** | [embedding-in-a-harper-app.md](embedding-in-a-harper-app.md) |

---

## What changes across shapes

Not everything is the same. The critical differences:

### Identity

- **Standalone local & Fabric (over HTTP):** Agents authenticate with Ed25519-signed requests. Each agent holds a private key and signs `agentId:timestamp:nonce:METHOD:/path` on every request. The server verifies the signature against the agent's registered public key.
- **Embedded (in-process):** Identity is **asserted**, not verified. You pass the agent id via the call context — `agentContext("mybot")` — and Flair acts as that agent. No key, no signature, no `Agent`-table lookup. Co-location *is* the trust boundary: a caller inside the same Harper instance could write the storage tables directly anyway, so demanding a signature from same-process code would be theatre. **Never build the context from request data** — that is privilege escalation with no error and no trace.

### Upgrade

- **Standalone local:** `flair upgrade` — install, restart, verify, rollback-on-failure in one step.
- **Hosted on Fabric:** `flair upgrade --target <fabric-url>` — resolves the target version, stages a clean deployable, and pushes it. Fabric has no `flair upgrade` equivalent to the local path; redeploy the component.
- **Embedded:** Flair follows your host app's dependency lifecycle. When you update `@tpsdev-ai/flair` in your app's `package.json` and redeploy, Flair upgrades with the rest. There is no `flair upgrade` — it's a component, not a standalone process.

### Federation

- **Standalone local & Fabric:** Available. Hub-and-spoke sync with pairing tokens, signed requests, and originator enforcement. The CLI drives pairing (`flair federation pair`).
- **Embedded:** Pairing is **CLI-only** today — it requires shell access on the node ([flair#947](https://github.com/tpsdev-ai/flair/issues/947)). If your deployment has no shell, federation is not available.

### `@export`

`@export` on a GraphQL schema means **REST exposure only** — it does not mean replication. `Memory` has no `@export` and still replicates in a Harper Fabric cluster (replication is per-database, not per-export). This is a genuine and easily-inverted trap: do not assume `@export` controls sync or that the absence of `@export` means "not replicated."
