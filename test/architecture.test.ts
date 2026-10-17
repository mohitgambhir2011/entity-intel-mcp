// Mechanical guards for the architecture in docs/13-architecture.md. They fail the build when a
// change breaks the layering or writes to the protocol channel, so reviews can focus on logic.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Which top-level areas of src/ each area may import from (itself is always allowed). */
const ALLOWED: Record<string, string[]> = {
  core: [],
  resolution: ["core"],
  infra: ["core"],
  sanctions: ["core", "infra", "resolution"],
  adapters: ["core", "infra"],
  services: ["core", "resolution", "adapters", "infra", "sanctions", "runtime"],
  server: ["core", "services", "runtime"],
  runtime: ["core", "infra", "adapters"],
  index: ["core", "runtime", "server"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** "src/services/gather.ts" -> "services"; "src/runtime.ts" -> "runtime". */
function area(file: string): string {
  const first = relative(SRC, file).split(sep)[0]!;
  return first.replace(/\.ts$/, "");
}

function importsOf(file: string): { spec: string; target: string }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; target: string }[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const spec = m[1]!;
    out.push({ spec, target: area(resolve(dirname(file), spec.replace(/\.js$/, ".ts"))) });
  }
  return out;
}

describe("architecture", () => {
  const all = files(SRC);

  it("every source area is covered by the layering table", () => {
    const unknown = [...new Set(all.map(area))].filter((a) => !(a in ALLOWED));
    expect(unknown, "add the new area to ALLOWED in test/architecture.test.ts").toEqual([]);
  });

  it("modules only import from the layers they are allowed to depend on", () => {
    const violations: string[] = [];
    for (const file of all) {
      const from = area(file);
      for (const { spec, target } of importsOf(file)) {
        if (target === from || ALLOWED[from]?.includes(target)) continue;
        violations.push(`${relative(SRC, file)} imports ${spec} (${from} -> ${target})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never writes to stdout, which carries the MCP protocol", () => {
    const offenders = all.filter((f) =>
      /console\.(log|info|debug)\s*\(|process\.stdout\.write/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("keeps secrets out of source: no hard-coded keys or tokens", () => {
    const offenders = all.filter((f) =>
      /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_-]{12,}["']/i.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("does not use eval or dynamic code loading", () => {
    const offenders = all.filter((f) =>
      /\beval\s*\(|new Function\s*\(|child_process/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
