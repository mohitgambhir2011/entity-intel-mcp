// Replays the golden set (test/golden/entities.json) through the full server using recorded fixtures.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startHarness } from "../harness.js";

interface Expect {
  entityId: string;
  status?: string;
  statusGroup?: string;
  identifiers: string[];
  legalName: string;
  jurisdiction: string;
  conflicts: number;
}
interface Entry {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  expect: Expect;
}

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "entities.json"), "utf8")) as {
  entities: Entry[];
};

const harness = await startHarness();
afterAll(() => harness.close());

describe("golden set", () => {
  it.each(golden.entities.map((e) => [e.name, e] as const))("%s", async (_name, entry) => {
    const r = await harness.call(entry.tool, entry.args);
    expect(r.isError).toBe(false);
    const d = r.json.data;
    const want = entry.expect;
    expect(d.entityId).toBe(want.entityId);
    expect(d.names.find((n: { kind: string }) => n.kind === "legal")?.name).toBe(want.legalName);
    expect(d.jurisdiction).toBe(want.jurisdiction);
    expect(d.conflicts).toHaveLength(want.conflicts);
    expect(
      d.identifiers.map((i: { scheme: string; value: string }) => `${i.scheme}=${i.value}`).sort(),
    ).toEqual([...want.identifiers].sort());
    if (want.status) expect(d.status.value.normalized).toBe(want.status);
    if (want.statusGroup) expect(d.status.value.group).toBe(want.statusGroup);
  });
});
