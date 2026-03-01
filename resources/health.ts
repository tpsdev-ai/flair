import { Resource } from "harperdb";

export class Health extends Resource {
  async get() {
    return { ok: true };
  }
}
