import { Resource } from "@harperfast/harper";

export class Health extends Resource {
  async get() {
    return { ok: true };
  }
}
