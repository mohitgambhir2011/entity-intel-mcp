# Security

Report vulnerabilities privately to the maintainer rather than opening a public issue. Contact details will be added before the first public release.

Design notes: API keys are read from environment variables only and are never logged or returned by any tool. Registry text is treated as untrusted data. See `docs/13-architecture.md` §3.8.
