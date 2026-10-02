- **`flair keys prune` reports orphan instance seeds, and moves them under the
  same `--apply` confirmation.**
  An orphan is a node-shaped id (`flair_<hex8>.key`, no `.pub`) that no Instance
  row names; the instance ids are read through the local ops API with the local
  admin credential. When those rows cannot be read — or the target is not on
  this host, or not on the HTTP port the ops port is derived from — nothing is
  offered as orphan and the run says why: a seed whose row set is unknown is
  never moved. A node-shaped id an Instance row names is reported as a live
  federation key and never pruned. `flair doctor` prints one advisory line with
  the count and the prune command, and never removes a key (flair#1925).
