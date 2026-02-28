import { Resource, tables } from 'harperdb';

export class SoulFeed extends Resource {
  async *connect(target: any, incomingMessages: any) {
    const subscription = await (tables as any).Soul.subscribe(target);
    
    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
