// One test per defect found in the second xhigh code review (sanctions module, 2026-10-17).
import { describe, expect, it } from "vitest";
import { hostMatches, HttpClient, type FetchLike } from "../../src/infra/http.js";
import { Cache } from "../../src/infra/cache.js";
import { MemoryStorage } from "../../src/infra/storage/memory.js";
import { ListIndex, SanctionsIndex } from "../../src/sanctions/index.js";
import { parseEu } from "../../src/sanctions/parsers/eu.js";
import { parseOfac } from "../../src/sanctions/parsers/ofac.js";
import { parseUk } from "../../src/sanctions/parsers/uk.js";
import type { SanctionEntry } from "../../src/sanctions/types.js";
import { acceptIdentifier, extractIdentifiers, isDateLike } from "../../src/sanctions/xml.js";
import { sanctionsRoutes } from "../harness.js";
import { fakeFetch, fixtureText, instantClock } from "../helpers.js";

const ofacDoc = (count: number, entries: string): string =>
  `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>01/02/2026</Publish_Date>` +
  `<Record_Count>${count}</Record_Count></publshInformation>${entries}</sdnList>`;

describe("review: truncated downloads are rejected, not parsed into a partial list", () => {
  it.each([
    ["UK", parseUk, "sanctions/uk-sample.xml"],
    ["EU", parseEu, "sanctions/eu-sample.xml"],
    ["OFAC", parseOfac, "sanctions/ofac-sample.xml"],
  ] as const)("%s: a file cut off half way fails", (_n, parse, file) => {
    const xml = fixtureText(file);
    expect(() => parse(xml.slice(0, Math.floor(xml.length / 2)))).toThrow(/incomplete/);
  });

  it("OFAC: fewer records than the file declares fails", () => {
    const one =
      "<sdnEntry><uid>1</uid><lastName>A COMPANY</lastName><sdnType>Entity</sdnType></sdnEntry>";
    expect(() => parseOfac(ofacDoc(5, one))).toThrow(/1 of 5 records/);
    expect(parseOfac(ofacDoc(1, one)).entries).toHaveLength(1);
  });
});

describe("review: only plausible registration numbers are indexed", () => {
  const entry = (types: [string, string][]): string =>
    "<sdnEntry><uid>7</uid><lastName>ACME TRADING</lastName><sdnType>Entity</sdnType><idList>" +
    types
      .map(([t, v], i) => `<id><uid>${i}</uid><idType>${t}</idType><idNumber>${v}</idNumber></id>`)
      .join("") +
    "</idList></sdnEntry>";

  it("OFAC: takes VAT/registration types, ignores dates, types and contact details", () => {
    const { entries } = parseOfac(
      ofacDoc(
        1,
        entry([
          ["Organization Established Date", "19 Dec 1989"],
          ["Organization Type:", "Limited Liability Company"],
          ["V.A.T. Number", "DE811128135"],
          ["Registration Number", "1027700132195"],
          ["Website", "www.example.com"],
          ["Unified Social Credit Code (USCC)", "91110000710935732K"],
          ["Digital Currency Address - XBT", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"],
        ]),
      ),
    );
    expect(entries[0]!.identifiers.sort()).toEqual(
      ["1027700132195", "91110000710935732K", "DE811128135"].sort(),
    );
  });

  it("dates are never identifiers, even inside free text", () => {
    expect(isDateLike("27/07/1992.")).toBe(true);
    expect(isDateLike("1992-07-27")).toBe(true);
    expect(acceptIdentifier("27/07/1992")).toBeUndefined();
    expect(acceptIdentifier("ABCDEFGH")).toBeUndefined(); // no digit
    expect(extractIdentifiers("1067746244026 dated 27/07/1992. Tax ID: 7705713236")).toEqual([
      "1067746244026",
      "7705713236",
    ]);
  });
});

describe("review: XML is parsed without entity expansion", () => {
  it("decodes &amp; in names and leaves custom entities unexpanded", () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]>' +
      "<sdnList><publshInformation><Publish_Date>01/02/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation>" +
      "<sdnEntry><uid>1</uid><lastName>SMITH &amp; SONS &lol2; L&apos;ORIENT</lastName><sdnType>Entity</sdnType></sdnEntry></sdnList>";
    const { entries } = parseOfac(bomb);
    expect(entries[0]!.names[0]!.name).toBe("SMITH & SONS &lol2; L'ORIENT");
  });
});

describe("review: low-quality aliases never reach 'match', whatever the threshold", () => {
  const e: SanctionEntry = {
    list: "OFAC_SDN",
    entryId: "1",
    subjectType: "person",
    names: [
      { name: "Ivan Petrov", primary: true, strong: true },
      { name: "Vanya Petrov", primary: false, strong: false },
    ],
    identifiers: [],
    programmes: [],
    countries: [],
  };
  it("stays below a lowered match threshold", () => {
    const [hit] = new ListIndex("OFAC_SDN", [e]).screen(
      { names: ["Vanya Petrov"], identifiers: [], kind: "any" },
      { match: 0.9, possible: 0.8 },
    );
    expect(hit!.score).toBeLessThan(0.9);
    expect(hit!.weakAlias).toBe(true);
  });
});

describe("review: HTTP details", () => {
  it("matches redirect domains on a dot boundary", () => {
    expect(hostMatches("bucket.s3.amazonaws.com", ".amazonaws.com")).toBe(true);
    expect(hostMatches("amazonaws.com", "amazonaws.com")).toBe(true);
    expect(hostMatches("evilamazonaws.com", "amazonaws.com")).toBe(false);
    expect(hostMatches("evilamazonaws.com", ".amazonaws.com")).toBe(false);
  });

  it("frees the connection of error responses it will not read", async () => {
    let cancelled = 0;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("not found page"));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 404 },
      );
    const http = new HttpClient({ fetch: fetchImpl, clock: instantClock() });
    await expect(http.getJson("https://x.test/a", { source: "x" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(cancelled).toBe(1);
  });

  it("decodes multi-byte characters split across stream chunks", async () => {
    const bytes = new TextEncoder().encode("<a>Ørsted Газпром</a>");
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
            c.close();
          },
        }),
      );
    const http = new HttpClient({ fetch: fetchImpl, clock: instantClock() });
    const r = await http.getText("https://x.test/a", { source: "x" });
    expect(r.body).toBe("<a>Ørsted Газпром</a>");
  });
});

describe("review: SanctionsIndex", () => {
  function make(fetchImpl: FetchLike, minEntries = 1) {
    const clock = instantClock();
    const http = new HttpClient({ fetch: fetchImpl, clock });
    const cache = new Cache(new MemoryStorage(), 86400, clock.now);
    return new SanctionsIndex({ http, cache, now: clock.now, minEntries });
  }

  it("does not let a finished load delete a newer in-flight load", async () => {
    const good = fixtureText("sanctions/eu-sample.xml");
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    let calls = 0;
    const idx = make(async () => {
      calls++;
      if (calls === 1) return new Response("<html>bad</html>");
      await latch;
      return new Response(good);
    });

    const first = idx.get("EU");
    const firstFailed = expect(first).rejects.toMatchObject({ kind: "bad_response" });
    const fresh = idx.get("EU", { fresh: true }); // second download, now in flight
    await firstFailed; // the first load's cleanup must not remove the second one's entry
    const third = idx.get("EU"); // should join the in-flight fresh load, not start a third
    release();
    await Promise.all([fresh, third]);
    expect(calls).toBe(2);
  });

  it("never accepts an empty list, even with the test floor set to 0", async () => {
    const empty = ofacDoc(0, "");
    const idx = make(async () => new Response(empty), 0);
    await expect(idx.get("OFAC_SDN")).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("uses each list's own date, and the download's Last-Modified only when the file has none", async () => {
    const f = fakeFetch(sanctionsRoutes());
    const idx = make(f);
    expect((await idx.get("UK")).versionDate).toBe("2026-10-16");
    expect((await idx.get("EU")).versionDate).toBe("2026-10-15");
    expect((await idx.get("OFAC_SDN")).versionDate).toBe("2026-10-15");

    // A list that states no date inside the file falls back to the HTTP header.
    const noDate = ofacDoc(
      1,
      "<sdnEntry><uid>1</uid><lastName>A COMPANY</lastName><sdnType>Entity</sdnType></sdnEntry>",
    ).replace("<Publish_Date>01/02/2026</Publish_Date>", "");
    const idx2 = make(
      async () =>
        new Response(noDate, { headers: { "last-modified": "Fri, 16 Oct 2026 10:00:00 GMT" } }),
    );
    expect((await idx2.get("OFAC_SDN")).versionDate).toBe("2026-10-16");
  });
});
