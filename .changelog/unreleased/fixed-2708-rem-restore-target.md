- **`flair rem restore --apply` lists candidates on the instance it writes to, and first checks that the two are one instance.**

  The writes go to `FLAIR_URL`, or to the local instance when it is unset. The
  candidate listing goes to the operations API on that same host, at
  `FLAIR_OPS_PORT` when it is set and otherwise at the port derived from
  `FLAIR_URL`; a target URL without a port has HTTP port 80 or 443. Before any
  listing, delete or write, restore checks that the operations port and the
  target's HTTP port belong to one instance, and refuses when that cannot be
  shown. On this host, the operations API's configuration must name the
  target's HTTP port and the OS listener table must show one Harper process on
  both ports, and a port pair that conflicts with this host's configured pair
  is refused. On another host, that configuration must name both ports, or
  both endpoints must report the same instance identity; two different
  identities are refused. Restore never takes its listing endpoint from
  `FLAIR_OPS_TARGET`, and it refuses a target URL that carries user info, a
  query or a fragment, printing none of their values (#2708).

  > **Heads-up:** restore now refuses while `FLAIR_OPS_TARGET` names an
  > endpoint other than the target's operations API; unset it for the restore.
