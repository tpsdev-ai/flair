// Injects a failure through the export module's write seam, never node:fs.
// MOCK_EXPORT_MODULE names the built module; MOCK_EXPORT_FAIL_MODE names the
// branch; MOCK_EXPORT_SEAM_LOG records the descriptor closes and temp removals.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(process.env.MOCK_EXPORT_MODULE).href);
const ops = mod.defaultExportWriteOps;
const mode = process.env.MOCK_EXPORT_FAIL_MODE ?? "";
const log = process.env.MOCK_EXPORT_SEAM_LOG;

const record = (line) => {
  if (log) appendFileSync(log, `${line}\n`);
};
const originalClose = ops.close;
ops.close = (fd) => {
  record(`close ${fd}`);
  originalClose(fd);
};

if (mode === "write" || mode === "write+unlink") {
  ops.write = () => {
    throw new Error("injected export write failure");
  };
}
if (mode === "fsync") {
  ops.fsync = () => {
    throw new Error("injected export fsync failure");
  };
}
if (mode === "link") {
  ops.link = () => {
    throw new Error("injected export link failure");
  };
}
if (mode === "write+unlink") {
  ops.unlink = (path) => {
    record(`unlink ${path}`);
    throw new Error("injected export temp removal failure");
  };
}
