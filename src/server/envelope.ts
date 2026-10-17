import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidInputError } from "../core/errors.js";
import type { SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";

/**
 * Response envelope shared by all tools (D25). `summary` and `warnings` are written by this server
 * only: registry-supplied text (names, addresses, remarks) must stay inside `data`.
 */
export interface Envelope<T> {
  summary: string;
  warnings: string[];
  data: T;
  meta: {
    entityId?: string;
    sourcesQueried: SourceId[];
    retrievedAt: string;
    fromCache: boolean;
    page?: { total: number; limit: number; offset: number };
  };
  disclaimer?: string;
}

export function ok<T>(
  rt: Runtime,
  e: {
    summary: string;
    data: T;
    warnings?: string[];
    entityId?: string;
    sourcesQueried?: SourceId[];
    fromCache?: boolean;
    page?: Envelope<T>["meta"]["page"];
    disclaimer?: string;
  },
): CallToolResult {
  const envelope: Envelope<T> = {
    summary: e.summary,
    warnings: e.warnings ?? [],
    data: e.data,
    meta: {
      entityId: e.entityId,
      sourcesQueried: e.sourcesQueried ?? [],
      retrievedAt: rt.now().toISOString(),
      fromCache: e.fromCache ?? false,
      page: e.page,
    },
    disclaimer: e.disclaimer,
  };
  return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Runs a tool body; expected input problems become tool errors, bugs become a generic error. */
export async function guard(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof InvalidInputError) return fail(err.message);
    console.error("tool failed:", err instanceof Error ? (err.stack ?? err.message) : err);
    return fail("Internal error while processing the request");
  }
}
