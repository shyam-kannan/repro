// Investigator configuration. Repro reads only its own REPRO_* variables and
// always talks to the official API endpoint, so it never picks up a coding
// session's ANTHROPIC_* key, token or base URL.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

export const LIMITS = {
  maxBrowserToolCalls: 15,
  deadlineMs: 90_000,
} as const;

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_PROVIDER_RETRIES = 2;

export type InvestigatorSettings = {
  model: string;
  maxOutputTokens: number;
  maxBrowserToolCalls: number;
  deadlineMs: number;
  // Retries of a failed model request, each recorded in the run log and
  // bounded by the same deadline. The SDK's own retries are turned off.
  maxProviderRetries: number;
};

export type AppConfig = { apiKey: string; settings: InvestigatorSettings };

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; config: AppConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const apiKey = env.REPRO_ANTHROPIC_API_KEY?.trim();
  const model = env.REPRO_MODEL?.trim();
  if (!apiKey) problems.push('REPRO_ANTHROPIC_API_KEY is not set');
  if (!model) problems.push('REPRO_MODEL is not set');
  const maxOutputTokens = positiveInteger(env.REPRO_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens === undefined) problems.push('REPRO_MAX_OUTPUT_TOKENS must be a positive integer');
  if (!apiKey || !model || maxOutputTokens === undefined) return { ok: false, problems };

  return {
    ok: true,
    config: {
      apiKey,
      settings: {
        model,
        maxOutputTokens,
        maxBrowserToolCalls: LIMITS.maxBrowserToolCalls,
        deadlineMs: LIMITS.deadlineMs,
        maxProviderRetries: DEFAULT_MAX_PROVIDER_RETRIES,
      },
    },
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
