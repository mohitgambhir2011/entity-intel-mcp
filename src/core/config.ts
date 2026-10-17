export interface Config {
  companiesHouseApiKey?: string;
  fcaAuthEmail?: string;
  fcaAuthKey?: string;
  adapterAllowList?: string[];
  dbPath?: string;
  personalDataTtlDays: number;
  auditRetentionDays: number;
  sanctionsMatch: number;
  sanctionsPossible: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function opt(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allow = opt(env.EIM_ADAPTERS);
  return {
    companiesHouseApiKey: opt(env.COMPANIES_HOUSE_API_KEY),
    fcaAuthEmail: opt(env.FCA_AUTH_EMAIL),
    fcaAuthKey: opt(env.FCA_AUTH_KEY),
    adapterAllowList: allow
      ?.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    dbPath: opt(env.EIM_DB_PATH),
    personalDataTtlDays: num(env.EIM_PERSONAL_DATA_TTL_DAYS, 30),
    auditRetentionDays: num(env.EIM_AUDIT_RETENTION_DAYS, 365),
    sanctionsMatch: num(env.EIM_SANCTIONS_MATCH, 0.95),
    sanctionsPossible: num(env.EIM_SANCTIONS_POSSIBLE, 0.8),
  };
}
