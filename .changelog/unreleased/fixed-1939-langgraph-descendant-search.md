- **A parent-prefix search in the LangGraph store returns items in descendant namespaces, and namespace labels are stored losslessly.**
  The non-semantic search matches whole namespace labels against the requested prefix and reads the agent's full item set with no candidate cap, so it no longer drops descendants or returns a short page when more matches exist. Labels containing `/` or `:` are now escaped in stored ids and tags; items written by earlier versions under such labels must be re-put. Other existing items need no migration. The semantic path's prefix filtering is unchanged.

  (Closes #1939)
