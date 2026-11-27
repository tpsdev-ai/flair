// Fails the export write at the module seam: the exclusive create has already
// succeeded when this throws. MOCK_EXPORT_MODULE names the built module.
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(process.env.MOCK_EXPORT_MODULE).href);
mod.defaultExportWriteOps.write = () => {
  throw new Error("injected export write failure");
};
