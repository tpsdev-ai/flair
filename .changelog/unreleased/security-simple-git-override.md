- **The workspace lockfile resolves simple-git 4.0.2 and @simple-git/argv-parser 2.0.1, outside the vulnerable ranges of four advisories.**
  Root `overrides` entries move the copy that `@tpsdev-ai/flair-bench` reaches through
  node-llama-cpp (GHSA-x6jw-m9v5-85vh, GHSA-858h-whjf-mvg5, GHSA-g4wm-2vf7-vfgr,
  GHSA-v5rq-49vh-5v5c), and their dated audit-allowlist entries are removed. Installs of
  the published `@tpsdev-ai/flair` package do not include simple-git. Installs of the
  separately published `@tpsdev-ai/flair-bench` package are not changed: package
  managers apply `overrides` only from the installing project's root, and
  node-llama-cpp 3.18.1 still declares simple-git ^3.33.0. Nothing to do on upgrade.
