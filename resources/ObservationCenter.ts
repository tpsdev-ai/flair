import { Resource } from "@harperfast/harper";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(HERE, "..", "..", "ui", "observation-center.html");
const HTML = readFileSync(HTML_PATH, "utf8");

/**
 * GET /ObservationCenter — serves the read-only dashboard shell.
 * The HTML handles its own Basic-auth prompt and polls authenticated JSON endpoints.
 */
export class ObservationCenter extends Resource {
  // The dashboard shell is just HTML + inline JS; the JS prompts the user
  // for admin-pass and authenticates each API call. The shell itself is
  // intentionally public so it can render before auth happens.
  allowRead() { return true; }

  async get() {
    return new Response(HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}
