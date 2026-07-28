- **Flair can now be driven entirely in-process, with per-agent scoping proven.** A Harper
  application that loads Flair as a sub-component can register any number of agents and act as
  each of them without a shell, a CLI or an HTTP hop — the shape a Fabric deployment has.
  `resources/in-process.ts` is the seam: `agentContext(agentId)` builds the context that makes a
  call act as one specific agent, and `collectionResource(Cls, context)` returns the
  collection-bound instance Harper requires for a create. Registration goes through the `Agent`
  resource, so a record gets the full Principal shape rather than a hand-copied literal, and
  Ed25519 key material can be minted with `node:crypto` alone.

  **The context object is a security boundary.** In-process identity is *asserted, not verified* —
  there is no signature, no lookup against the `Agent` table and no registration requirement, and
  `isAdmin` is asserted the same way. That is right for a caller already inside the trust boundary,
  and it means the context must be built from the app's own server-side state and **never** from
  request data: an agent id that reaches it from user input is privilege escalation with no error
  and no trace. Prefer individual agent identities over one shared app identity — a per-agent
  context costs nothing, while collapsing them loses per-agent attribution and turns N blast radii
  into one.

  `test/integration/in-process-agents.test.ts` boots a real second Harper application
  (`test/fixtures/inproc-app`, a copyable reference implementation) and pins all of it: two agents
  each write a private and a shared memory and neither can read the other's private one by search
  or by id; claiming another agent's id, naming an unregistered one, or asserting `isAdmin` each
  succeed exactly as documented; a context-**less** call resolves to Flair's trusted `internal`
  verdict and reads every agent's private records; and a fresh Harper process over the same storage
  resolves identical per-agent scope, so attribution is a property of the record rather than of the
  process that wrote it.
