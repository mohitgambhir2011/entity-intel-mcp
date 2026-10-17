# entity-intel-mcp

An [MCP](https://modelcontextprotocol.io) server for legal entity intelligence across the UK and Europe: company registries, GLEIF, VIES and sanctions lists, with source provenance on every field.

> **Status: early scaffold (v0.0.1).** One MCP tool (`check_coverage`) works. Core types, HTTP client, SQLite cache and the GLEIF, VIES and Companies House adapters exist and are tested, but are not yet exposed as MCP tools. See [docs/](docs/) for the plan, decisions and design.

## What it will do

- Look up and resolve legal entities by name or identifier (company number, LEI, VAT).
- Return identity, status, officers, ownership, filings, regulatory status, insolvency and sanctions screening.
- Say clearly what it could **not** return for a country, instead of returning silence.
- Primary use: KYB / due diligence. Secondary: research.

Planned rollout: UK + GLEIF + VIES + sanctions first, then Ireland and the Nordics, France, the Netherlands and Belgium. See `docs/01-DECISIONS.md`.

## Install and run (development)

Requires Node 22 or later.

```bash
npm install
npm run build
node dist/index.js
```

Claude Desktop config (once published):

```json
{
  "mcpServers": {
    "entity-intel": {
      "command": "npx",
      "args": ["-y", "entity-intel-mcp"],
      "env": { "COMPANIES_HOUSE_API_KEY": "...", "FCA_AUTH_EMAIL": "...", "FCA_AUTH_KEY": "..." }
    }
  }
}
```

## Configuration

You bring your own API keys; nothing is bundled. See [.env.example](.env.example) for all variables. Sources that need no key (GLEIF, VIES, Norway, Finland) are enabled automatically.

## Data, licences and your responsibilities

- Each data source has its own terms. This project's licence covers only this code, not the data.
- Officer and beneficial-owner data is **personal data**. You are responsible for having a lawful basis under GDPR/UK GDPR to process it.
- Results are not legal advice. Sanctions screening is name-based and is not a legal determination.
- Registry text is untrusted input; treat it as data, not instructions.

## Licence

[Elastic License 2.0](LICENSE). You may use, modify and self-host this software, but you may not offer it to third parties as a hosted or managed service. This is source-available, not OSI open source.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require agreeing to the [CLA](CLA.md).
