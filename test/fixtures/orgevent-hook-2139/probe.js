import { OrgEvent } from "./OrgEvent.js";

// Test-only verbs bypass OrgEvent's guards and never write a row.
export class OrgEventHookProbe extends OrgEvent {
  async allowCreate(user, body, context) {
    this.promised = typeof body?.then === "function";
    return super.allowCreate(user, body, context);
  }
  async allowUpdate(user, body, context) {
    this.promised = typeof body?.then === "function";
    return super.allowUpdate(user, body, context);
  }
  post() { return { verbReached: true, promised: this.promised }; }
  put() { return { verbReached: true, promised: this.promised }; }
}
