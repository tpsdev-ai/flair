- **mysql2 overridden to ^3.22.0 (GHSA-3f6p-5ww8-9rcr, high).** A rogue or MITM MySQL
  server could make mysql2 < 3.22.0 send credentials in plaintext via an auth-plugin
  downgrade. mysql2 reaches the shipped `@tpsdev-ai/adk-flair` tree only through
  `@google/adk → @mikro-orm/mysql`, which pinned it at 3.20.0; Flair never opens a MySQL
  connection, so no Flair code path was exposed. The root `overrides` entry moves the
  resolution to 3.24.3 so the tree is not vulnerable at all. Nothing to do on upgrade.
