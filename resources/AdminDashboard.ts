import { Resource, databases } from "@harperfast/harper";
import { layout, htmlResponse } from "./admin-layout.js";
import { allowAdmin } from "./agent-auth.js";

/**
 * GET /AdminDashboard — admin home page with system overview.
 *
 * allowRead()=allowAdmin (defense-in-depth): see Admin.ts for why
 * this closes a real gap, not just belt-and-suspenders — a verified
 * non-admin agent could otherwise read full instance stats (principal/agent/
 * memory/relationship counts) with no admin check at all.
 */
export class AdminDashboard extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    let principalCount = 0;
    let memoryCount = 0;
    let humanCount = 0;
    let agentCount = 0;

    try {
      for await (const p of (databases as any).flair.Agent.search()) {
        principalCount++;
        if (p.kind === "human") humanCount++;
        else agentCount++;
      }
    } catch { /* table may not exist */ }

    try {
      for await (const _ of (databases as any).flair.Memory.search()) {
        memoryCount++;
      }
    } catch { /* table may not exist */ }

    let idpCount = 0;
    try {
      for await (const _ of (databases as any).flair.IdpConfig.search()) {
        idpCount++;
      }
    } catch { /* table may not exist */ }

    let relationshipCount = 0;
    try {
      for await (const _ of (databases as any).flair.Relationship.search()) {
        relationshipCount++;
      }
    } catch { /* table may not exist */ }

    const content = `
      <h1>Dashboard</h1>
      <p class="subtitle">Flair instance overview</p>

      <div class="stats">
        <div class="card">
          <h3>Principals</h3>
          <div class="value">${principalCount}</div>
          <div>${humanCount} human, ${agentCount} agent</div>
        </div>
        <div class="card">
          <h3>Memories</h3>
          <div class="value">${memoryCount}</div>
        </div>
        <div class="card">
          <h3>Relationships</h3>
          <div class="value">${relationshipCount}</div>
        </div>
        <div class="card">
          <h3>IdP Configs</h3>
          <div class="value">${idpCount}</div>
        </div>
      </div>
    `;

    return htmlResponse(layout("Dashboard", content, "home"));
  }
}
