- **flair-client percent-encodes Memory ids in request paths.**
  `memory.write`, `get`, `update` and `delete` send the id as one encoded path segment, as Soul requests already did, so an id containing characters such as `#`, `?`, `%`, `/` or a space addresses exactly that memory. The server decodes the segment, so ids made only of ordinary characters address the same records as before.
