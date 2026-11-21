import { InvalidInputError, SourceError } from "../core/errors.js";
import type { Availability, OfficerAppointmentsResult } from "../core/people.js";
import type { SourceId } from "../core/types.js";
import type { Runtime } from "../runtime.js";
import { adapterContext, describeFailure } from "./gather.js";

export interface OfficerAppointmentsOutcome {
  appointments: Availability<OfficerAppointmentsResult>;
  warnings: string[];
  sourcesQueried: SourceId[];
}

/** The register's person id, as `get_officers` returns it: letters, digits, dash, underscore. */
export const OFFICER_REF = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Appointments listed under one register person id (D49). Evidence only: it never says whether the
 * person is a nominee, and a person split over several ids shows only the appointments of this one.
 */
export async function getOfficerAppointments(
  rt: Runtime,
  input: { officerRef: string; fresh?: boolean },
): Promise<OfficerAppointmentsOutcome> {
  if (!OFFICER_REF.test(input.officerRef)) {
    throw new InvalidInputError(
      "officer_ref is not a register person id (use the officerRef from get_officers)",
    );
  }
  const adapter = rt.adapters.find((a) => a.officerAppointments);
  if (!adapter) {
    return {
      appointments: {
        state: "unavailable",
        reason: "requires_credentials",
        detail:
          "The UK register that provides appointments is not enabled (no Companies House key)",
      },
      warnings: [],
      sourcesQueried: [],
    };
  }
  try {
    const res = await adapter.officerAppointments!(
      input.officerRef,
      adapterContext(rt, input.fresh),
    );
    const warnings: string[] = [];
    if (!res) {
      return {
        appointments: {
          state: "unavailable",
          reason: "no_such_record",
          detail: "The register has no such person id",
        },
        warnings,
        sourcesQueried: [adapter.id],
      };
    }
    if (res.truncated) {
      warnings.push(
        `The register lists ${res.total} appointments but only ${res.appointments.length} could be read`,
      );
    }
    if (res.skipped > 0) {
      warnings.push(
        `${res.skipped} register entr${res.skipped === 1 ? "y has" : "ies have"} no usable company number and ${res.skipped === 1 ? "is" : "are"} not listed`,
      );
    }
    return {
      appointments: { state: "available", data: res },
      warnings,
      sourcesQueried: [adapter.id],
    };
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const detail = describeFailure(adapter.id, err);
    return {
      appointments: { state: "error", detail },
      warnings: [detail],
      sourcesQueried: [adapter.id],
    };
  }
}
