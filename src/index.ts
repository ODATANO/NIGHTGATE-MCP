#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(config);
  // stdio transport: stdout is the protocol channel, diagnostics go to stderr
  console.error(`nightgate-mcp: connecting tools to ${config.baseUrl}${config.servicePath}`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('nightgate-mcp failed to start:', err);
  process.exit(1);
});
