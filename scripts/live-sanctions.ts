// Downloads the real sanctions lists and screens a few names. Not part of the test suite.
// Run: npx tsx scripts/live-sanctions.ts   (about 110 MB on first run; cached afterwards)
import { loadConfig } from "../src/core/config.js";
import { createRuntime } from "../src/runtime.js";
import { screenSanctions } from "../src/services/screen.js";

const rt = createRuntime(loadConfig());
for (const list of rt.sanctions.lists) {
  const t0 = Date.now();
  try {
    const l = await rt.sanctions.get(list);
    console.log(
      `${list}: ${l.entries} entries, version ${l.versionDate}, ${(Date.now() - t0) / 1000}s`,
    );
  } catch (e) {
    console.log(`${list}: FAILED ${e instanceof Error ? e.message : e}`);
  }
}
for (const [name, kind] of [
  ["Gazprom Neft", "entity"],
  ["Gazprm Neft PJSC", "entity"],
  ["Sberbank of Russia", "entity"],
  ["Tesco PLC", "entity"],
  ["Barclays Bank PLC", "entity"],
  ["Vladimir Putin", "person"],
  ["John Smith", "person"],
] as const) {
  const t0 = Date.now();
  const o = await screenSanctions(rt, { name, kind });
  const top = o.screening.hits
    .slice(0, 2)
    .map((h) => `${h.list}:${h.entryName} (${h.score}, ${h.basis})`);
  console.log(
    `${name.padEnd(22)} -> ${o.screening.result.padEnd(14)} ${top.join(" | ")}  [${Date.now() - t0}ms]`,
  );
}
rt.storage.close();
