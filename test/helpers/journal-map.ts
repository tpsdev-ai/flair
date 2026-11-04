/** A transaction Map whose writes use Harper's addWrite/commit protocol. */
export function journalMap(rows: Map<string, any>, store: any, txn: any): Map<string, any> {
  const staged = new Map(rows);
  staged.set = (key, value) => {
    const operation: any = {
      key, store, entry: rows.has(key) ? { value: rows.get(key), version: 1 } : null,
      commit() {
        if (txn.dropPredecessorClose && key === "predecessor" && value?.validTo) {
          operation.stagedEntry = undefined;
          return;
        }
        Map.prototype.set.call(staged, key, value);
        operation.stagedEntry = { value };
      },
    };
    txn.addWrite(operation);
    return staged;
  };
  staged.delete = (key) => {
    const had = staged.has(key);
    const operation: any = {
      key, store, entry: rows.has(key) ? { value: rows.get(key), version: 1 } : null,
      commit() { Map.prototype.delete.call(staged, key); operation.stagedEntry = { value: undefined }; },
    };
    txn.addWrite(operation);
    return had;
  };
  return staged;
}
