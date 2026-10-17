import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/core/config.js";
import { MemoryStorage } from "../src/infra/storage/memory.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createServer } from "../src/server/server.js";
import { fakeFetch, fixtureText, instantClock, type FakeFetch, type FakeRoute } from "./helpers.js";

const GLEIF = "https://api.gleif.org/api/v1";
const CH = "https://api.company-information.service.gov.uk";
const VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

/** Small real samples of the three sanctions lists (OFAC is served via the S3 redirect it uses). */
export function sanctionsRoutes(): Record<string, FakeRoute | FakeRoute[]> {
  const s3 =
    "https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/x/SDN.XML";
  return {
    "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml": {
      body: fixtureText("sanctions/uk-sample.xml"),
    },
    "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content": {
      body: fixtureText("sanctions/eu-sample.xml"),
    },
    "https://www.treasury.gov/ofac/downloads/sdn.xml": {
      status: 302,
      body: "",
      headers: { location: `${s3}?X-Amz-Expires=3600` },
    },
    [s3]: { body: fixtureText("sanctions/ofac-sample.xml") },
  };
}

/**
 * Norway (Equinor ASA, a bankrupt company) and Finland (Nokia Oyj, plus real ceased, bankrupt,
 * in-liquidation and housing companies) with their GLEIF and VIES records. Individuals in the
 * Norwegian roles are synthetic. Specific URLs come before the shorter ones they extend.
 */
export function nordicRoutes(): Record<string, FakeRoute | FakeRoute[]> {
  const BR = "https://data.brreg.no/enhetsregisteret/api";
  const PRH = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";
  const f = (path: string): FakeRoute => ({ body: fixtureText(path) });
  const empty: FakeRoute = { body: JSON.stringify({ totalResults: 0, companies: [] }) };
  return {
    [`${BR}/enheter/923609016/roller`]: f("brreg_no/equinor-roller.json"),
    [`${BR}/enheter/923609016`]: f("brreg_no/equinor.json"),
    [`${BR}/enheter/935567645/roller`]: { body: JSON.stringify({ rollegrupper: [] }) },
    [`${BR}/enheter/935567645`]: f("brreg_no/konkurs.json"),
    [`${BR}/enheter?navn=`]: f("brreg_no/search-equinor.json"),
    [`${PRH}?businessId=0112038-9`]: f("prh_fi/nokia.json"),
    [`${PRH}?businessId=0100002-9`]: f("prh_fi/0100002-9.json"),
    [`${PRH}?businessId=0104057-3`]: f("prh_fi/0104057-3.json"),
    [`${PRH}?businessId=0100723-9`]: f("prh_fi/0100723-9.json"),
    [`${PRH}?businessId=0100024-8`]: f("prh_fi/0100024-8.json"),
    [`${PRH}?businessId=`]: empty,
    [`${PRH}?name=`]: f("prh_fi/search-nokia.json"),
    [`${GLEIF}/lei-records/OW6OFBNCKXC4US5C7523`]: f("gleif/lei-equinor.json"),
    [`${GLEIF}/lei-records/549300A0JPRWG1KI7U06`]: f("gleif/lei-nokia.json"),
    [`${GLEIF}/lei-records?filter[entity.registeredAs]=923%20609%20016`]: f(
      "gleif/by-registration-equinor.json",
    ),
    [`${GLEIF}/lei-records?filter[entity.registeredAs]=0112038-9`]: f(
      "gleif/by-registration-nokia.json",
    ),
    [`${VIES}/FI/vat/01120389`]: f("vies/fi-valid.json"),
  };
}

/**
 * Officers, PSC and the Tesco group chain (Tesco Stores -> Tesco Holdings -> Tesco PLC, which is
 * exempt from PSC reporting as a listed company). Individuals are synthetic; companies are real.
 * Sub-resource URLs must be listed before the plain company URL they share a prefix with.
 */
export function peopleRoutes(): Record<string, FakeRoute | FakeRoute[]> {
  const f = (name: string): FakeRoute => ({ body: fixtureText(`companies_house/${name}.json`) });
  const notFound: FakeRoute = { status: 404, body: "" };
  return {
    [`${CH}/company/00445790/officers`]: f("officers-tesco"),
    [`${CH}/company/00445790/persons-with-significant-control-statements`]: notFound,
    [`${CH}/company/00445790/persons-with-significant-control`]: f("tesco-psc"),
    [`${CH}/company/00445790/exemptions`]: f("tesco-exemptions"),
    [`${CH}/company/00519500/persons-with-significant-control`]: f("stores-psc"),
    [`${CH}/company/00519500`]: f("profile-00519500"),
    [`${CH}/company/00243011/persons-with-significant-control`]: f("holdings-psc"),
    [`${CH}/company/00243011`]: f("profile-00243011"),
    [`${CH}/company/01074897/persons-with-significant-control`]: f("havin-psc"),
    [`${CH}/company/01074897/exemptions`]: notFound,
    [`${CH}/company/01074897`]: f("profile-01074897"),
  };
}

/** Recorded responses for the Tesco PLC golden entity and a few VAT numbers. */
export function defaultRoutes(): Record<string, FakeRoute | FakeRoute[]> {
  return {
    ...peopleRoutes(),
    ...nordicRoutes(),
    [`${GLEIF}/lei-records/2138002P5RNKC5W2JZ46`]: { body: fixtureText("gleif/lei-tesco.json") },
    [`${GLEIF}/lei-records?filter[entity.registeredAs]=00445790`]: {
      body: fixtureText("gleif/by-registration-tesco.json"),
    },
    [`${GLEIF}/lei-records?filter[entity.registeredAs]=`]: { body: JSON.stringify({ data: [] }) },
    [`${GLEIF}/lei-records?filter[entity.legalName]=`]: {
      body: fixtureText("gleif/search-tesco.json"),
    },
    [`${CH}/company/00445790`]: { body: fixtureText("companies_house/company-tesco.json") },
    [`${CH}/search/companies`]: { body: fixtureText("companies_house/search-tesco.json") },
    [`${VIES}/IE/vat/6388047V`]: { body: fixtureText("vies/ie-valid.json") },
    [`${VIES}/DE/vat/811128135`]: { body: fixtureText("vies/de-name-withheld.json") },
    [`${VIES}/NL/vat/820571204B01`]: { body: fixtureText("vies/nl-invalid.json") },
    ...sanctionsRoutes(),
  };
}

export interface Harness {
  client: Client;
  rt: Runtime;
  fetch: FakeFetch;
  /** Calls a tool and returns the parsed envelope (or the raw error text). */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; json?: any; text: string }>;
  close(): Promise<void>;
}

export async function startHarness(
  opts: {
    env?: NodeJS.ProcessEnv;
    routes?: Record<string, FakeRoute | FakeRoute[]>;
    /** Replaces the default fake fetch, e.g. to add latency. */
    fetchImpl?: FakeFetch;
  } = {},
): Promise<Harness> {
  const env = opts.env ?? { COMPANIES_HOUSE_API_KEY: "test-key" };
  const f = opts.fetchImpl ?? fakeFetch(opts.routes ?? defaultRoutes());
  const rt = createRuntime(loadConfig(env), {
    env,
    fetch: f,
    storage: new MemoryStorage(),
    clock: instantClock(),
    sanctionsMinEntries: 1,
  });
  const server = createServer(rt);
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  return {
    client,
    rt,
    fetch: f,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const first = (res.content as { type: string; text: string }[])[0]!;
      const isError = res.isError === true;
      return { isError, text: first.text, json: isError ? undefined : JSON.parse(first.text) };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
