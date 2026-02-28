import { tables } from "harperdb";

export class Integration extends (tables as any).Integration {
  async post(target: unknown, record: any) {
    // S31-A: API never accepts plaintext credentials.
    if (typeof record?.credential === "string" || typeof record?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return super.post(target, record);
  }
}
