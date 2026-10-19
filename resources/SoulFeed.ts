import { Resource, databases } from 'harper';
import { allowVerified } from './agent-auth.js';
import { subscribeInProcess } from './table-subscription-policy.js';

export class FeedSouls extends Resource {
  // Self-authorize the subscription via the Ed25519 agent verify (auth reshape
  // removes the gate's admin elevation). FeedSouls extends Resource (not a Table),
  // so getContext().request is reachable in allow* — same pattern as SemanticSearch.
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async *connect(target: any, incomingMessages: any) {
    const subscription = await subscribeInProcess((databases as any).flair.Soul, target);
    
    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
