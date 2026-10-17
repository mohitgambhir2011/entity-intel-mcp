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
  /** Human-readable problems found while loading (invalid values replaced by defaults). */
  problems: string[];
}

function opt(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads a number from the environment. Values that are not numbers or fall outside [min, max] are
 * replaced by the default and reported in `problems`, so a typo can't silently disable a safeguard
 * (e.g. EIM_SANCTIONS_MATCH=95 would otherwise mean nothing ever matches).
 */
function bounded(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = opt(env[name]);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${name} must be a number between ${min} and ${max}; using default ${fallback}`);
    return fallback;
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const allow = opt(env.EIM_ADAPTERS);

  const sanctionsMatch = bounded(env, "EIM_SANCTIONS_MATCH", 0.95, 0.5, 1, problems);
  let sanctionsPossible = bounded(env, "EIM_SANCTIONS_POSSIBLE", 0.8, 0.5, 1, problems);
  if (sanctionsPossible > sanctionsMatch) {
    problems.push("EIM_SANCTIONS_POSSIBLE must not exceed EIM_SANCTIONS_MATCH; using 0.8");
    sanctionsPossible = Math.min(0.8, sanctionsMatch);
  }

  return {
    companiesHouseApiKey: opt(env.COMPANIES_HOUSE_API_KEY),
    fcaAuthEmail: opt(env.FCA_AUTH_EMAIL),
    fcaAuthKey: opt(env.FCA_AUTH_KEY),
    adapterAllowList: allow
      ?.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    dbPath: opt(env.EIM_DB_PATH),
    personalDataTtlDays: bounded(env, "EIM_PERSONAL_DATA_TTL_DAYS", 30, 0, 3650, problems),
    auditRetentionDays: bounded(env, "EIM_AUDIT_RETENTION_DAYS", 365, 1, 3650, problems),
    sanctionsMatch,
    sanctionsPossible,
    problems,
  };
}
