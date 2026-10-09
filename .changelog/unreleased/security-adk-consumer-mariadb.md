- **The published `@tpsdev-ai/adk-flair` package now depends on Google ADK 2.x, so its consumers no longer resolve a vulnerable mariadb.**

  npm overrides declared inside a package never applied to that package's
  consumers, so this repository's root mariadb override left a plain
  `@tpsdev-ai/adk-flair` install resolving mariadb 3.4.5 — via `@google/adk` 1.x
  -> `@mikro-orm/mariadb`. `@google/adk` 2.x declares the MikroORM SQL drivers
  as optional peers, which npm does not install, so the mariadb copy is absent
  from a consumer install. The `Dependency Audit` job now packs and installs the
  ADK tarball and audits that install, the same observation the root tarball gets.
