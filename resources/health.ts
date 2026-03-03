import { Resource } from "harper";

export class Health extends Resource {
  async get() {
    return { ok: true };
  }
}
