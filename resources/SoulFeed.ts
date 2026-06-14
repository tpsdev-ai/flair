import { Resource, databases } from '@harperfast/harper';
import { verifyAgentRequest } from './agent-auth.js';

export class FeedSouls extends Resource {
  // Self-authorize the subscription via the Ed25519 agent verify (auth reshape
  // removes the gate's admin elevation). FeedSouls extends Resource (not a Table),
  // so getContext().request is reachable in allow* — same pattern as SemanticSearch.
  async allowRead(): Promise<boolean> {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    return !!(await verifyAgentRequest(request));
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
