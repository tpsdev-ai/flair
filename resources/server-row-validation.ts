/**
 * flair#2997 — validate a row the server built with its own table's validator
 * before staging it, so a schema defect in server-built data is a server error,
 * not a caller error.
 *
 * `databases.flair.<Table>` is the table class. The validator the commit path
 * runs is the one on the class prototype: Harper's staged-write validate
 * closure calls `this.validate(recordUpdate, !fullUpdate)` (harper 5.3.1,
 * resources/Table.ts), and `this.validate` on a table instance resolves to that
 * prototype method. The class itself has no static `validate`.
 *
 * On the pinned Harper a row refused here is refused at commit with the same
 * issues (proven on a live instance for InstructionVersion and OrgEvent: the
 * pre-validation and the staging path raised identical `errors` arrays and the
 * accepted row stored byte-identical). A failure is therefore a server defect,
 * not a caller error.
 *
 * The rows validated here carry caller-derived fields, and each of those fields
 * is coerced to the schema's type where it is assigned, so a schema failure on
 * the row is a server defect, not a caller error. A Memory successor or close
 * row carries the caller's fields without that coercion, so it keeps the
 * commit-time path: a defect in one of its fields, a server-stamped field
 * included, answers the caller's 400 rather than 5xx.
 */
export class ServerRowValidationError extends Error {
  constructor(tableName: string, cause: unknown) {
    super(`the server built an invalid ${tableName} row; the write was aborted`, { cause });
    this.name = "ServerRowValidationError";
  }
}

/**
 * The table handle exposes no validator: a Harper change removed the entry
 * point this check depends on. Distinct from {@link ServerRowValidationError}
 * (an invalid row) so the reason is visible in the server log and a test can
 * tell them apart. The write is still refused (fail closed).
 */
export class ServerRowValidatorMissingError extends Error {
  constructor(tableName: string) {
    super(`the ${tableName} table handle exposes no validator; the write was aborted`);
    this.name = "ServerRowValidatorMissingError";
  }
}

/**
 * Run the table's own `validate(record, patch)` on the exact object about to
 * be staged. `patch` must be the commit's flag (`false` for the full-row
 * creates/puts this helper serves).
 *
 * Throws {@link ServerRowValidationError} when the validator refuses the row
 * and {@link ServerRowValidatorMissingError} when the handle exposes no
 * validator — never a Harper `ValidationError`, so a caller-row 400 path cannot
 * claim it. The caller's catch aborts the transaction and answers its 5xx
 * shape.
 */
export function validateServerRow(table: any, record: Record<string, unknown>, patch = false): void {
  const tableName = typeof table?.name === "string" && table.name.length > 0 ? table.name : "unknown";
  const holder = table?.prototype && typeof table.prototype.validate === "function" ? table.prototype : table;
  const validate = holder?.validate;
  if (typeof validate !== "function") throw new ServerRowValidatorMissingError(tableName);
  try {
    validate.call(table, record, patch);
  } catch (err) {
    console.error("flair: a server-built row failed its table validator; the write was aborted (table %s)", tableName, err);
    throw new ServerRowValidationError(tableName, err);
  }
}
