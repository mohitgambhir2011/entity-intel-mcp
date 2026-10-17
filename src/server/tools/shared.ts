import { z } from "zod";

/** Arguments shared by every tool that starts from one entity (flat on purpose, see D33). */
export const entityRefShape = {
  entity_id: z
    .string()
    .optional()
    .describe("Entity id from a previous result, e.g. GB:CH:00445790 or ID:LEI:<lei>"),
  identifier: z
    .string()
    .optional()
    .describe("LEI, UK company number or EU VAT number (e.g. IE6388047V)"),
  scheme: z.enum(["LEI", "GB_CRN", "VAT"]).optional().describe("Identifier type, if not obvious"),
  country: z
    .string()
    .length(2)
    .optional()
    .describe("Needed with a bare numeric identifier, e.g. GB for a UK company number"),
  fresh: z.boolean().optional().describe("Bypass the cache and re-fetch from the sources"),
};

/** Every tool is read-only and idempotent; those that call registries are open-world. */
export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;
