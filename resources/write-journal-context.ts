import { AsyncLocalStorage } from "node:async_hooks";
import type { WriteJournal } from "./write-journal.js";

export const writeJournalScope = new AsyncLocalStorage<WriteJournal | null>();

export function currentWriteJournal(): WriteJournal | undefined {
  return writeJournalScope.getStore() ?? undefined;
}
