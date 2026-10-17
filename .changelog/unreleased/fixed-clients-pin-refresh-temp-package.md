- **The MCP pin-refresh unit test now rewrites a TEMP copy of package.json.**
  It used to rewrite the repository's own, bumping its mtime so the
  dist-freshness gate refused to start Harper in the release integration step
  (flair#2588).
