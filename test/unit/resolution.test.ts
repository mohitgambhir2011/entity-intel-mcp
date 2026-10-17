import { describe, expect, it } from "vitest";
import { normaliseName } from "../../src/resolution/normalise.js";
import { scoreName } from "../../src/resolution/score.js";

describe("normaliseName", () => {
  it.each([
    ["Tesco PLC", "tesco"],
    ["TESCO P.L.C.", "tesco"],
    ["The Tesco Public Limited Company", "tesco"],
    ["Müller GmbH", "muller"],
    ["Société Générale S.A.", "societe generale"],
    ["Novo Nordisk A/S", "novo nordisk"],
    ["Heineken N.V.", "heineken"],
    ["Marks & Spencer Group plc", "marks and spencer group"],
  ])("%s -> %s", (input, key) => {
    expect(normaliseName(input).key).toBe(key);
  });

  it("never strips a name down to nothing", () => {
    expect(normaliseName("Limited").key).toBe("limited");
    expect(normaliseName("PLC Co").key).not.toBe("");
  });

  it("reports the removed suffix", () => {
    expect(normaliseName("Foo Ltd").suffix).toBe("ltd");
  });
});

describe("scoreName", () => {
  it("scores identical names 1 and renamed legal forms high with a warning", () => {
    expect(scoreName("Tesco PLC", "TESCO PLC").score).toBe(1);
    const m = scoreName("Tesco Ltd", "Tesco PLC");
    expect(m.band).toBe("high");
    expect(m.warnings.join(" ")).toContain("legal form");
  });

  it("scores a name prefix as medium, never high", () => {
    const m = scoreName("tesco", "Tesco Treasury Services PLC");
    expect(m.band).toBe("medium");
    expect(m.reasons[0]).toContain("start of the name");
  });

  it("scores unrelated names low", () => {
    expect(scoreName("tesco", "KFORD TYRES (GORNAL) LTD").band).toBe("low");
  });

  it("never returns the certain band", () => {
    expect(scoreName("acme", "acme").band).not.toBe("certain");
  });
});
