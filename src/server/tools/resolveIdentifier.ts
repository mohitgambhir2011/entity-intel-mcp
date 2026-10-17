import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Runtime } from "../../runtime.js";
import { resolveRef } from "../../services/entityRef.js";
import { gather } from "../../services/gather.js";
import { mergePartials } from "../../services/merge.js";
import { guard, ok } from "../envelope.js";
import { entityRefShape, READ_ONLY } from "./shared.js";

export function registerResolveIdentifier(server: McpServer, rt: Runtime): void {
  server.registerTool(
    "resolve_identifier",
    {
      description:
        "Convert between identifiers for the same legal entity (LEI <-> UK company number, VAT " +
        "validity) and say whether the identifier is valid. Use it to confirm a number before " +
        "calling get_entity, or to find the other identifiers of an entity.",
      inputSchema: entityRefShape,
      annotations: READ_ONLY,
    },
    (args) =>
      guard(async () => {
        const seed = resolveRef(args);
        const g = await gather(rt, seed, { fresh: args.fresh });
        rt.audit.record({
          tool: "resolve_identifier",
          subject: `${seed.scheme}:${seed.value}`,
          sources: g.sourcesQueried,
          cacheHit: g.fromCache,
        });

        if (g.partials.length === 0) {
          return ok(rt, {
            summary: `No source returned a record for this ${seed.scheme}.`,
            warnings: g.warnings,
            data: {
              found: false,
              detectedScheme: seed.scheme,
              identifier: seed.value,
              formatValid: true, // resolveRef already rejected malformed identifiers
              identifiers: [],
            },
            sourcesQueried: g.sourcesQueried,
          });
        }

        const profile = mergePartials(g.partials, g.sourcesQueried);
        const self = profile.identifiers.find(
          (i) => i.scheme === seed.scheme && i.value === seed.value,
        );
        return ok(rt, {
          summary: `Resolved to ${profile.entityId}; ${profile.identifiers.length} identifier(s) known.`,
          warnings: g.warnings,
          data: {
            found: true,
            entityId: profile.entityId,
            aliases: profile.aliases,
            detectedScheme: seed.scheme,
            identifier: seed.value,
            validated: self?.validated ?? false,
            identifiers: profile.identifiers.map((i) => ({
              scheme: i.scheme,
              value: i.value,
              country: i.country,
              status: i.status,
              validated: i.validated,
              sources: [...new Set(i.provenance.map((p) => p.source))],
            })),
            notes: g.partials.flatMap((p) => p.notes),
          },
          entityId: profile.entityId,
          sourcesQueried: g.sourcesQueried,
          fromCache: g.fromCache,
        });
      }),
  );
}
