- **Bootstrap now resolves org-scope skill assignments (`OrgSkillAssignment`) together with the agent's own; an org entry in `skills` has `scope: "org"`.** (flair#2141)
  A row carries `skillName`, `priority` and `skillRef`, the id of the skill row
  it assigns; its `skillId` in `skills` is that `skillRef`, and a `skillRef`
  that is not a live skill row the agent can read is reported `unresolved` in
  `skillDiagnostics`. It applies to a target whose Agent record has `kind`
  agent and `status` active (absent counts as both), under the same priority
  and tie rules as the agent's own assignments. A Soul `skill-assignment` row
  with `metadata.optOut: true` whose `originatorInstanceId` is this instance's
  id removes the org assignments with that name for that agent.

  Verified agents read `GET /OrgSkillAssignment`. `POST`, `PUT`, `PATCH` and
  `DELETE` need Admin Basic credentials or Flair's internal path; agent keys,
  admin-agent keys included, get 403. Each accepted write appends an
  `OrgSkillAssignmentHistory` row (actor, source class, and the hash of the row
  before the write, null on a create); that table has no REST surface. Neither
  table is federated.

  A Soul `skill-assignment` row whose `metadata.optOut` is not a boolean is
  refused with 400, and so is an `AgentSeed` request whose `soulTemplate` has a
  `skill-assignment` key. At start, the server brings an existing
  `flair_agent` role up to this release's grants.
