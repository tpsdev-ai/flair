- **An operator update that changes only a Soul's `agentId` closes its old history window and opens one under the new `agentId`.**
  `agentId` is part of the Soul subject identity alongside `key`, so `PUT` and `PATCH` close the previous window when either half changes; an update that changes neither opens no new window.
