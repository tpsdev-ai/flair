- **flair-client, the ADK Python memory service and the Hermes plugin sign the path they send when the base URL has a path.**
  Each builds the final request URL once — the route joined onto the base URL's
  own path with exactly one slash, whether or not the base ends in "/" — and
  signs that URL's path plus query, so a deployment served under a path (for
  example `FLAIR_URL=https://host/flair`) signs and sends the same `/flair/...`
  path it addresses. A base URL that carries a query string or fragment is
  refused before any request.
