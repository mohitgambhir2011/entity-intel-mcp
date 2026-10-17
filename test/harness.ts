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

/** Recorded responses for the Tesco PLC golden entity and a few VAT numbers. */
export function defaultRoutes(): Record<string, FakeRoute | FakeRoute[]> {
  return {
    [`${GLEIF}/lei-records/2138002P5RNKC5W2JZ46`]: { body: fixtureText("gleif/lei-tesco.json") },
    [`${GLEIF}/lei-records?filter[entity.registeredAs]=00445790`]: {
      body: fixtureText("gleif/by-registration-tesco.json"),
    },
    [`${GLEIF}/lei-records?filter[entity.legalName]=`]: {
      body: fixtureText("gleif/search-tesco.json"),
    },
    [`${CH}/company/00445790`]: { body: fixtureText("companies_house/company-tesco.json") },
    [`${CH}/search/companies`]: { body: fixtureText("companies_house/search-tesco.json") },
    [`${VIES}/IE/vat/6388047V`]: { body: fixtureText("vies/ie-valid.json") },
    [`${VIES}/DE/vat/811128135`]: { body: fixtureText("vies/de-name-withheld.json") },
    [`${VIES}/NL/vat/820571204B01`]: { body: fixtureText("vies/nl-invalid.json") },
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
  } = {},
): Promise<Harness> {
  const env = opts.env ?? { COMPANIES_HOUSE_API_KEY: "test-key" };
  const f = fakeFetch(opts.routes ?? defaultRoutes());
  const rt = createRuntime(loadConfig(env), {
    env,
    fetch: f,
    storage: new MemoryStorage(),
    clock: instantClock(),
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
