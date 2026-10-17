import { describe, expect, it } from "vitest";
import {
  detectIdentifier,
  isValidLei,
  normalizeGbCompanyNumber,
  parseVat,
} from "../../src/core/identifiers.js";
import { fallbackEntityId, makeEntityId } from "../../src/core/ids.js";

describe("isValidLei", () => {
  it("accepts a real LEI", () => {
    expect(isValidLei("2138002P5RNKC5W2JZ46")).toBe(true);
    expect(isValidLei("2138 002P 5RNK C5W2 JZ46")).toBe(true);
  });
  it("rejects bad checksum and bad shape", () => {
    expect(isValidLei("2138002P5RNKC5W2JZ47")).toBe(false);
    expect(isValidLei("TOOSHORT")).toBe(false);
    expect(isValidLei("2138002P5RNKC5W2JZ4X")).toBe(false);
  });
});

describe("normalizeGbCompanyNumber", () => {
  it("pads numeric numbers to 8 digits", () => {
    expect(normalizeGbCompanyNumber("445790")).toBe("00445790");
  });
  it("keeps prefixed numbers", () => {
    expect(normalizeGbCompanyNumber("sc 123456")).toBe("SC123456");
  });
  it("rejects garbage", () => {
    expect(normalizeGbCompanyNumber("ABC")).toBeUndefined();
    expect(normalizeGbCompanyNumber("123456789")).toBeUndefined();
  });
});

describe("parseVat", () => {
  it("splits country and number", () => {
    expect(parseVat("IE 6388047V")).toEqual({ country: "IE", number: "6388047V" });
  });
  it("rejects unknown prefixes (GB is not in VIES)", () => {
    expect(parseVat("GB123456789")).toBeUndefined();
  });
});

describe("detectIdentifier", () => {
  it("detects LEI, VAT and prefixed GB numbers", () => {
    expect(detectIdentifier("2138002P5RNKC5W2JZ46")?.scheme).toBe("LEI");
    expect(detectIdentifier("IE6388047V")?.scheme).toBe("VAT");
    expect(detectIdentifier("SC123456")).toMatchObject({ scheme: "GB_CRN", value: "SC123456" });
  });
  it("only treats bare digits as GB when the country says so", () => {
    expect(detectIdentifier("00445790")).toBeUndefined();
    expect(detectIdentifier("00445790", "GB")).toMatchObject({ scheme: "GB_CRN" });
  });
});

describe("entity ids (D20)", () => {
  it("builds registry ids", () => {
    expect(makeEntityId("gb", "ch", "00445790")).toBe("GB:CH:00445790");
  });
  it("fallback id is stable across case, accents and punctuation", () => {
    expect(fallbackEntityId("Café  Tesco, Ltd.", "gb")).toBe(
      fallbackEntityId("cafe tesco ltd", "GB"),
    );
  });
});
