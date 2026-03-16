import { Resource, databases } from '@harperfast/harper';

export class FeedSouls extends Resource {
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
