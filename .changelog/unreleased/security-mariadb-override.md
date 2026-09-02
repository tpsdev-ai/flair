- **mariadb overridden to ~3.4.7 (GHSA-cqhc-2h57-wpxf high; GHSA-g5xc-5w98-jfvm, GHSA-42r5-vhpq-m858 moderate).** The
  three advisories were parked in the audit allowlist on the premise that no fixed 3.4.x
  existed; mariadb 3.4.7 shipped on 2026-09-01 with the fixes. mariadb reaches the shipped
  `@tpsdev-ai/adk-flair` tree only through `@google/adk → @mikro-orm/mariadb` (pinned
  3.4.5) and Flair never opens a MariaDB connection. The root `overrides` entry moves it
  to 3.4.7 on the same minor line and the three allowlist entries are removed. Nothing
  to do on upgrade.
