import { tables } from "@harperfast/harper";

export class Integration extends (tables as any).Integration {
  async post(content: any, context?: any) {
    // S31-A: API never accepts plaintext credentials.
    if (typeof content?.credential === "string" || typeof content?.token === "string") {
      return new Response(JSON.stringify({ error: "plaintext_credentials_forbidden" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.post(content, context);
  }
}
