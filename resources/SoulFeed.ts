import { Resource, databases } from '@harperfast/harper';
import { allowVerified } from './agent-auth.js';
import { MCP_HIDDEN } from "./mcp-curation.js";

export class FeedSouls extends Resource {
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
  // Self-authorize the subscription via the Ed25519 agent verify (auth reshape
  // removes the gate's admin elevation). FeedSouls extends Resource (not a Table),
  // so getContext().request is reachable in allow* — same pattern as SemanticSearch.
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async *connect(target: any, incomingMessages: any) {
    const subscription = await (databases as any).flair.Soul.subscribe(target);
    
    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
