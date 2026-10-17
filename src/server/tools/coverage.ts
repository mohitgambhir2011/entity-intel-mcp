import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Runtime } from "../../runtime.js";
import { guard, ok } from "../envelope.js";

export function registerCoverage(server: McpServer, rt: Runtime): void {
  server.registerTool(
    "check_coverage",
    {
      description:
        "Report which data sources are enabled, which credentials are configured (variable names " +
        "only, never values) and what this server can currently return. Call this first if a " +
        "lookup returns less than expected.",
      inputSchema: {
        country: z.string().length(2).optional().describe("ISO 3166 country code, e.g. GB"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ country }) =>
      guard(async () => {
        const wanted = country?.toUpperCase();
        const adapters = rt.statuses.filter(
          (a) => !wanted || a.country === wanted || a.country === "EU",
        );
        const enabled = adapters.filter((a) => a.enabled).length;
        const warnings: string[] = [];
        if (enabled === 0) warnings.push("No source adapters are enabled");
        // From the enabled adapters, so the list can not go stale when a country is added.
        const countriesWith = (family: "officers" | "controllers"): string =>
          [...new Set(rt.adapters.filter((a) => a[family] && a.country).map((a) => a.country!))]
            .sort()
            .join(", ") || "none enabled";
        return ok(rt, {
          summary: `${enabled} of ${adapters.length} sources enabled.`,
          warnings,
          data: {
            adapters,
            sanctionsLists: rt.sanctions.status(),
            familiesSupported: [
              "identity",
              `officers (${countriesWith("officers")}: get_officers)`,
              `ownership (${countriesWith("controllers")}: get_ownership)`,
              "sanctions (screen_sanctions)",
            ],
            familiesNotYetSupported: ["filings", "regulatory", "insolvency"],
          },
        });
      }),
  );
}
