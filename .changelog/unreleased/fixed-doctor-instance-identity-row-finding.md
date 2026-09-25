- **`flair doctor` reports an unread pairing-role check even when it also reports an identity row finding.**

  The row facts and the pairing-role check are two separate reads, and doctor
  printed the pairing-role status only on its no-finding path. An instance with
  several `Instance` rows AND an unreadable role list therefore printed the rows
  and said nothing about the pairing-role check that never ran — the one state
  where both facts matter. Both now print: the row finding with its remedy, and
  the pairing-role `UNVERIFIED` line naming what could not be read.

  (Refs #1883)
