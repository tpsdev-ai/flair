import { tables } from "harperdb";

export class Agent extends (tables as any).Agent {
  async post(content: any, context: any) {
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    return super.post(content, context);
  }
}
