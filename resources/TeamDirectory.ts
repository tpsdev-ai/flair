import { Resource } from "harper";
import { allowVerified } from "./agent-auth.js";
import { resolveTeamDirectory } from "./team-directory.js";

/**
 * GET /TeamDirectory — the team directory over local records (flair#2141 S3a).
 *
 * Serves the SAME resolver as the `team_directory` MCP tool and the flair
 * client. Query parameters
 * (`id`, `name`, `cursor`, `limit`) filter and page the list; authority is the
 * resolver's verified-active-reader gate, which reads past Integration's
 * owner-only REST scope in-process. `allowRead` blocks anonymous HTTP before
 * the handler, and the resolver refuses `internal` and a missing context as
 * well — a reader that is not a verified active agent gets nothing.
 */
export class TeamDirectory extends Resource {
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async get(pathInfo?: any) {
    const context = (this as any).getContext?.();
    return resolveTeamDirectory(context, {
      id: queryValue(pathInfo, "id") ?? undefined,
      name: queryValue(pathInfo, "name") ?? undefined,
      cursor: queryValue(pathInfo, "cursor") ?? undefined,
      limit: queryValue(pathInfo, "limit") ?? undefined,
    });
  }
}

/** Read one query parameter off Harper v5's parsed `conditions` on pathInfo. */
function queryValue(pathInfo: any, name: string): string | null {
  if (typeof pathInfo !== "object" || pathInfo === null) return null;
  const found = pathInfo.conditions?.find((c: any) => c.attribute === name)?.value;
  return found === undefined || found === null ? null : String(found);
}
