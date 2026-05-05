import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
export declare function isValidAgentId(agentId: string | null | undefined): boolean;
export declare function assertValidAgentId(agentId: string | null | undefined): asserts agentId is string;
declare const _default: {
    kind: "memory";
    register(api: OpenClawPluginApi): void;
};
export default _default;
