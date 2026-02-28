import { tables } from "harperdb";

export class Soul extends (tables as any).Soul {
  async post(target: unknown, record: any) {
    record.durability ||= "permanent";
    record.createdAt = new Date().toISOString();
    record.updatedAt = record.createdAt;
    return super.post(target, record);
  }
}
