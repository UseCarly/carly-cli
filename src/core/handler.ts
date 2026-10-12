import type { CommandDefinition } from './types.js';
import type { CarlyClient } from './client.js';

/**
 * Generic command executor — builds the HTTP request from a CommandDefinition
 * and the validated input, then dispatches via the client.
 */
export async function executeCommand(
  def: CommandDefinition,
  input: Record<string, unknown>,
  client: CarlyClient,
): Promise<unknown> {
  let path = def.endpoint.path;
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};

  for (const [field, location] of Object.entries(def.fieldMappings)) {
    const value = input[field];
    if (value === undefined || (value === null && location !== 'body')) continue;

    if (location === 'path') {
      path = path.replace(`{${field}}`, encodeURIComponent(String(value)));
    } else if (location === 'query') {
      query[field] = value;
    } else if (location === 'body') {
      body[field] = value;
    }
  }

  const method = def.endpoint.method.toUpperCase();

  if (method === 'GET') return client.get(path, query);
  if (method === 'DELETE') return client.delete(path, query);
  if (method === 'PATCH') return client.patch(path, Object.keys(body).length > 0 ? body : undefined);
  if (method === 'PUT') return client.put(path, Object.keys(body).length > 0 ? body : undefined);
  return client.post(path, Object.keys(body).length > 0 ? body : undefined);
}
