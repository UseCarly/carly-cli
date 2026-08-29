import type { z } from 'zod';
import type { CarlyClient } from './client.js';

export interface CliArgMapping {
  field: string;
  name: string;
  required?: boolean;
}

export interface CliOptionMapping {
  field: string;
  flags: string;
  description?: string;
}

export interface CliMapping {
  args?: CliArgMapping[];
  options?: CliOptionMapping[];
}

export interface CommandDefinition<TInput extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  group: string;
  subcommand: string;
  description: string;
  examples?: string[];
  inputSchema: TInput;
  cliMappings: CliMapping;
  endpoint: { method: string; path: string };
  fieldMappings: Record<string, 'path' | 'query' | 'body'>;
  /** API-key scope the endpoint demands (shown in help + generated docs). */
  scope?: string;
  paginated?: boolean;
  /**
   * Columns shown when --output table is used for this command.
   * If unset, the table renderer falls back to the scalar keys of the first row.
   * For commands whose response is a single object (not a list), table mode is
   * not supported — the renderer falls back to pretty JSON.
   */
  defaultColumns?: string[];
  handler: (input: z.infer<TInput>, client: CarlyClient) => Promise<unknown>;
}

export interface GlobalOptions {
  apiKey?: string;
  apiBaseUrl?: string;
  output?: string;
  pretty?: boolean;
  quiet?: boolean;
  fields?: string;
}
