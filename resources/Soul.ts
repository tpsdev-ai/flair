import { databases } from "@harperfast/harper";

export class Soul extends (databases as any).flair.Soul {
  async post(content: any, context?: any) {
    content.durability ||= "permanent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    return super.post(content, context);
  }
}
