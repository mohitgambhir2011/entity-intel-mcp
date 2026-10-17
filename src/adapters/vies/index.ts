import { SourceError } from "../../core/errors.js";
import { parseVat } from "../../core/identifiers.js";
import { makeStatus } from "../../core/types.js";
import type { PartialEntity, Provenance } from "../../core/types.js";
import { TTL } from "../../infra/cache.js";
import { iso, type SourceAdapter } from "../types.js";

const BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

interface ViesResponse {
  isValid?: boolean;
  userError?: string;
  name?: string;
  address?: string;
  vatNumber?: string;
}

/** VIES uses "---" for fields the member state does not release (e.g. Germany withholds names). */
export function viesField(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v !== "---" ? v : undefined;
}

const TRANSIENT_ERRORS = new Set([
  "MS_UNAVAILABLE",
  "MS_MAX_CONCURRENT_REQ",
  "TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "GLOBAL_MAX_CONCURRENT_REQ",
]);

export const viesAdapter: SourceAdapter = {
  id: "vies",

  supports: (id) => id.scheme === "VAT" && parseVat(id.value) !== undefined,

  async lookup(identifier, ctx): Promise<PartialEntity | undefined> {
    const parsed = parseVat(identifier.value);
    if (!parsed) return undefined;
    const { country, number } = parsed;
    const url = `${BASE}/${country}/vat/${number}`;

    const res = await ctx.cache.getOrFetch(
      `vies:${country}:${number}`,
      { ttlSeconds: TTL.vies, source: "vies", fresh: ctx.fresh },
      async () => {
        const r = await ctx.http.getJson<ViesResponse>(url, { source: "vies", allowStatus: [400] });
        const body = r.body ?? {};
        const err = body.userError ?? "";
        if (TRANSIENT_ERRORS.has(err)) {
          throw new SourceError(
            `VIES: member state service unavailable (${err})`,
            "vies",
            "unavailable",
          );
        }
        if (err === "INVALID_INPUT") {
          throw new SourceError("VIES rejected the VAT number format", "vies", "bad_response");
        }
        return body;
      },
    );

    const body = res.value;
    const prov: Provenance = {
      source: "vies",
      sourceRecordId: `${country}${number}`,
      sourceUrl: url,
      retrievedAt: iso(ctx, res.fetchedAt),
      fromCache: res.fromCache,
    };
    const valid = body.isValid === true;
    const name = viesField(body.name);
    const address = viesField(body.address);
    const notes: string[] = [];
    if (!valid) notes.push("VIES reports this VAT number as not valid or not registered");
    if (valid && !name) notes.push(`${country} does not release the registered name through VIES`);

    return {
      source: "vies",
      names: name ? [{ name, kind: "legal", provenance: [prov] }] : [],
      identifiers: [
        {
          scheme: "VAT",
          value: `${country}${number}`,
          country,
          status: valid ? "active" : "unknown",
          validated: valid,
          provenance: [prov],
        },
      ],
      jurisdiction: country === "EL" ? "GR" : country === "XI" ? "GB" : country,
      status: valid
        ? undefined
        : { value: makeStatus("unknown", "VAT number not valid"), provenance: [prov] },
      registeredAddress: address
        ? {
            value: {
              lines: address
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean),
              formatted: address.replace(/\s*\n\s*/g, ", "),
            },
            provenance: [prov],
          }
        : undefined,
      notes,
    };
  },
};
