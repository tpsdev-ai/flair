- **A parent-prefix search in the LangGraph store now returns items stored under descendant namespaces, by a component-prefix tag match.**
  The queryless (non-semantic) search lists by a PREFIX match on the stored full-namespace
  tag (`lg-ns:<a/b/c>`), by namespace COMPONENT: `("users",)` matches `lg-ns:users/profiles`
  and `lg-ns:users/profiles/u123` but not `lg-ns:usersX`; an empty prefix matches every
  `lg-ns:` item. It fetches the agent's full set and selects by tag prefix, so it no longer
  drops descendants or returns a short page when more matches exist. Items written with the
  single full tag are covered with no migration — the match reads the tag they already carry.
  The semantic path's prefix filtering is unchanged.

  (Closes #1939)
