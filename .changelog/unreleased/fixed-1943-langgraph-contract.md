- **`FlairStore` implements LangGraph's `BaseStore` interface, and its documentation describes what it does.**
  `FlairStore` adds public `listNamespaces()`, `start()` and `stop()`, so it can be passed wherever LangGraph expects a `BaseStore`, including a compiled graph's `store`. The README, source comments, package description and integrations catalog now describe its identity options, default visibility and federation behaviour, persistence, retrieval and namespace-enumeration limits as the code implements them.

  (Refs #1943)
