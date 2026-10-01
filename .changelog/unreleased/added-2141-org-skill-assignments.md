- **Bootstrap now resolves org-scope skill assignments (`OrgSkillAssignment`) together with the agent's own; an org entry in `skills` has `scope: "org"`.** (flair#2141)
  A row carries `skillName`, `priority` and `skillRef`; its `skillId` in
  `skills` is that `skillRef`. It applies to a target whose Agent record has
  `kind` agent and `status` active (absent counts as both), under the same
  priority and tie rules as the agent's own assignments. A Soul
  `skill-assignment` row with `metadata.optOut: true` removes the org
  assignments with that name for that agent when this instance's id can be
  read and the row's `originatorInstanceId` equals it.

  Verified agents read `GET /OrgSkillAssignment`. `POST`, `PUT`, `PATCH` and
  `DELETE` need Admin Basic credentials or Flair's internal path; agent keys,
  admin-agent keys included, get 403. Each accepted write appends an
  `OrgSkillAssignmentHistory` row (actor, source class, and the hash of the row
  before the write, null on a create); writes to one assignment are serialized
  within a Harper process. There is no direct `/OrgSkillAssignmentHistory`
  route. Neither table is federated.

  Soul `POST`, `PUT` and `PATCH` refuse with 400 a `skill-assignment` row whose
  `metadata.optOut` is not a boolean; `AgentSeed` refuses with 400 a request
  whose `soulTemplate` has a `skill-assignment` key. At start, the server
  attempts to bring an existing `flair_agent` role up to this release's grants
  and logs a failure.
