import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveAuth } from '../core/auth.js';
import { CarlyClient } from '../core/client.js';
import { version } from '../core/version.js';
import { allCommands } from '../commands/index.js';

export function createMcpServer(client: CarlyClient): McpServer {
  const server = new McpServer({
    name: 'Carly Forms & Bookings',
    version,
  });

  for (const cmdDef of allCommands) {
    server.registerTool(
      cmdDef.name,
      {
        description: cmdDef.description,
        inputSchema: cmdDef.inputSchema.shape,
        annotations: cmdDef.annotations ?? {
          readOnlyHint: cmdDef.endpoint.method === 'GET',
          destructiveHint: ['DELETE', 'PATCH', 'PUT'].includes(cmdDef.endpoint.method),
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await cmdDef.handler(cmdDef.inputSchema.parse(args), client);
          return {
            ...(result && typeof result === 'object' && 'error' in result ? { isError: true } : {}),
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: error?.message ?? String(error),
                  code: error?.code ?? 'UNKNOWN_ERROR',
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

export async function startMcpServer(opts: { apiKeyFlag?: string; baseUrlFlag?: string } = {}): Promise<void> {
  const { apiKey, baseUrl } = await resolveAuth(opts);
  const server = createMcpServer(new CarlyClient({ apiKey, baseUrl }));
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `Carly Forms & Bookings MCP started. ${allCommands.length} tool(s) registered:\n` +
      allCommands.map((c) => `  - ${c.name}`).join('\n'),
  );
}
