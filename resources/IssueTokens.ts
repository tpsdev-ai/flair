import { Resource, databases } from "@harperfast/harper";

export class IssueTokens extends Resource {
  static loadAsInstance = false;

  async get(_target: unknown) {
    const { refresh_token: refreshToken, operation_token: jwt } =
      await (databases as any).system.hdb_user.operation(
        { operation: "create_authentication_tokens" },
        this.getContext(),
      );
    return { refreshToken, jwt };
  }

  async post(_target: unknown, data: any) {
    if (!data?.username || !data?.password) {
      throw new Error("username and password are required");
    }

    const { refresh_token: refreshToken, operation_token: jwt } =
      await (databases as any).system.hdb_user.operation({
        operation: "create_authentication_tokens",
        username: data.username,
        password: data.password,
      });

    return { refreshToken, jwt };
  }
}
