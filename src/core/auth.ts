import { loadConfig } from './config.js';
import { AuthError } from './errors.js';

export const DEFAULT_API_BASE_URL = 'https://carlyassistant.com';

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
}

/**
 * Resolve the Carly API key + base URL in priority order:
 *   1. CLI flags (--api-key, --api-base-url)
 *   2. Env vars (CARLY_API_KEY, CARLY_API_BASE_URL)
 *   3. ~/.carly-cli/config.json
 *   4. Built-in default base URL
 */
export async function resolveAuth(opts: {
  apiKeyFlag?: string;
  baseUrlFlag?: string;
} = {}): Promise<ResolvedAuth> {
  const config = await loadConfig();

  const apiKey =
    opts.apiKeyFlag ?? process.env.CARLY_API_KEY ?? config.apiKey;

  const baseUrl =
    (opts.baseUrlFlag ?? process.env.CARLY_API_BASE_URL ?? config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  if (!apiKey) {
    throw new AuthError(
      'No Carly API key found.\n\n' +
        'Options:\n' +
        '  1. Run: carly login\n' +
        '  2. Set env var: export CARLY_API_KEY=<key>\n' +
        '  3. Pass flag: carly --api-key <key> <command>\n\n' +
        `Mint a key at ${DEFAULT_API_BASE_URL}/booking-pages (expand "Generate API key" under "Use Carly from your terminal or AI agent").`,
    );
  }

  return { apiKey, baseUrl };
}
