import { databases } from "@harperfast/harper";

export class Agent extends (databases as any).flair.Agent {
  async post(content: any, context: any) {
    content.type ||= "agent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    return super.post(content, context);
  }
}
