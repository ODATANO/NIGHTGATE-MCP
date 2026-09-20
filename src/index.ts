#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(config);
  // stdio transport: stdout is the protocol channel, diagnostics go to stderr
  if (!config.token && !config.username && /api.odatano.dev$/.test(config.baseUrl)) {
    console.error('nightgate-mcp: ODATANO_ACCESS_KEY is not set; api.odatano.dev answers 401 without a key (sign in, redeem a code or buy a pack at https://api.odatano.dev)');
  }
  console.error(`nightgate-mcp: connecting tools to ${config.baseUrl}${config.servicePath}`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('nightgate-mcp failed to start:', err);
  process.exit(1);
});
