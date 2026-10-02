// Test-only resource loaded by Harper after the replay-store modules.
import { Resource } from "harper";

export class ReplayBootOrderProbe extends Resource {
  allowRead() { return true; }

  get() {
    console.error("[replay-boot-order-probe] request served");
    return { served: true };
  }
}
