- **The release pack set must name every package, the environment check sees both GitHub forms, and every workflow declares explicit permissions.**

  An explicitly empty `--dirs` is a declared set, not an omitted one: it now
  refuses before any package is packed, naming the members it skipped. The
  repo-wide check normalises a job's `environment:` to its name, so the
  `{ name, url }` form is seen as well as the string form. And every workflow
  under `.github/workflows` now declares a top-level `permissions:` block with
  the least privilege its steps need — an absent block inherits the repository
  default, which is not "no write" — with a check that refuses any workflow
  without one and any job outside the release stage that grants
  `deployments: write`.

  (Refs #1671)
