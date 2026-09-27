- **A parent-prefix search in the LangGraph store returns items in descendant namespaces, and namespace labels use a reversible stored encoding.**
  The non-semantic search matches whole namespace labels against the requested prefix and reads the agent's full item set with no candidate cap, so it no longer drops descendants or returns a short page when more matches exist. Labels containing `/` or `:` are escaped in stored ids and tags. Earlier items under valid labels without `/` or `:` keep their ids and tags; items stored under labels containing either character must be deleted by id and written again. The semantic path still checks the requested namespace prefix after retrieving candidates.

  (Closes #1939)
