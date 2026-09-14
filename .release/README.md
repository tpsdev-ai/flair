# First-publish approvals

Adding a **new public package name under our npm org** is a deliberate, recorded
act (flair#1674). The release preflight (`scripts/first-publish-check.mjs`) treats
a new public name as **blocked by default**: publishing one requires a positive
entry here, never the mere absence of an objection.

The release would first-publish a name when the name is one of:

- a workspace package whose `package.json` is not `private: true` (including the
  root `@tpsdev-ai/flair`), or
- an `npm:<name>@<version>` alias into our scope (`@tpsdev-ai/…`) declared by a
  package the release would publish — the "reprint" shape that
  `@tpsdev-ai/harper` used in flair#847.

## Adding an approval

Each entry records **name + approver + date + reason**. All four are required; an
entry missing any of them is not an approval and the release stays blocked.

```json
{
  "approved": [
    {
      "name": "@tpsdev-ai/new-package",
      "approver": "nathan",
      "date": "2026-09-14",
      "reason": "Replaces the private internal helper; intended to be a supported public package."
    }
  ]
}
```

The file deliberately starts with **no entries**. A release that flags a package
is the gate working: it is the moment to decide explicitly whether the name
should exist publicly at all, or should be removed from the release.
