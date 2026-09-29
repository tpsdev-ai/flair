// events-jsonl-1897.ts — the ONE writer for the flair#1897 schedule event logs,
// shared by the worker helper (instance-create-worker-1897.ts) and the tests
// that drive it, so the test's own events land through the same path.
//
// ORDER IS READ FROM POSITION IN THE FILE, NEVER FROM `t` (flair#2029). The
// events come from different threads, and a release -> hold handoff can finish
// inside one millisecond on a fast runner, so two `Date.now()` stamps tie and a
// strict `>` on them flakes. A line's position is a total order only if every
// event lands as ONE atomic append: the file is opened O_APPEND ("a"), the
// whole line goes out in ONE write, and a short write throws instead of leaving
// a torn line for a sibling's append to land inside. `t` stays in the line for
// diagnostics only.
import { closeSync, openSync, writeSync } from "node:fs";

export function appendEvent(file: string, tid: number | string, ev: string, extra: Record<string, unknown> = {}): void {
  const line = Buffer.from(JSON.stringify({ tid, ev, t: Date.now(), ...extra }) + "\n", "utf8");
  const fd = openSync(file, "a");
  try {
    const written = writeSync(fd, line, 0, line.length);
    if (written !== line.length) {
      throw new Error(`events log ${file}: short append (${written}/${line.length} bytes); its line order is no longer a witness`);
    }
  } finally {
    closeSync(fd);
  }
}
