"use strict";

// flair#1450 — injected into test-harness Harper only (NODE_OPTIONS --require).
//
// An orphaned Harper must EXIT, not EPIPE-loop. The 2026-08-29 tps-anvil
// incident: the parent that owned stdout died, this process was reparented to
// systemd --user, each failed write logged an error, logging that error also
// failed, 17.8 GB in two hours. The defect is that the process is still running.
//
// Two independent exits, either sufficient:
//   1. EPIPE on stdout/stderr — the pipe's reader is gone.
//   2. ppid changed — we were reparented. Identified by ppid, never by name.
//
// Do not write on the exit path. Writing is the loop.
// This file runs IN the child. It does not register handlers on the test runner
// (federation-watch.test.ts SIGTERMs the runner as a fixture).

const ownerPpid = process.ppid;

function exitOrphan() {
  try {
    process.exit(1);
  } catch {
    process.abort();
  }
}

function armStream(stream) {
  if (!stream || typeof stream.write !== "function") return;
  stream.on("error", (err) => {
    if (err && err.code === "EPIPE") exitOrphan();
  });
  const origWrite = stream.write;
  stream.write = function writeOrExit(chunk, encoding, cb) {
    let enc = encoding;
    let callback = cb;
    if (typeof encoding === "function") {
      callback = encoding;
      enc = undefined;
    }
    const wrapped = function onWrite(err) {
      if (err && err.code === "EPIPE") exitOrphan();
      if (typeof callback === "function") callback.apply(this, arguments);
    };
    try {
      if (enc === undefined && callback === undefined) return origWrite.call(this, chunk);
      if (callback === undefined) return origWrite.call(this, chunk, enc);
      if (enc === undefined) return origWrite.call(this, chunk, wrapped);
      return origWrite.call(this, chunk, enc, wrapped);
    } catch (err) {
      if (err && err.code === "EPIPE") exitOrphan();
      throw err;
    }
  };
}

armStream(process.stdout);
armStream(process.stderr);

const poll = setInterval(() => {
  if (process.ppid !== ownerPpid) exitOrphan();
}, 200);
if (typeof poll.unref === "function") poll.unref();
