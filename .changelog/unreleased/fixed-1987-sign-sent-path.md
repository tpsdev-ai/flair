- **flair-client, the ADK Python memory service and the Hermes plugin sign the path they send when the base URL has a path.**
  Each client builds the final request once, the route joined onto the base
  URL's own path (a base with or without a trailing "/" addresses the same
  URL), and signs that request's path plus query. A base URL that carries a
  query string or fragment is refused before any request.
