#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { loadConfig } from './config.js';
import { NightgateClient } from './client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const analytics = await new NightgateClient(config).analyticsStatus();
  const server = buildServer(config, { analytics: analytics === 'served' });
  // stdio transport: stdout is the protocol channel, diagnostics go to stderr
  if (!config.token && !config.username && /^https:\/\/api(\.[a-z0-9-]+)?\.odatano\.dev$/.test(config.baseUrl)) {
    console.error('nightgate-mcp: ODATANO_ACCESS_KEY is not set; api.preprod.odatano.dev answers 401 without a key (sign in, redeem a code or buy a pack at https://api.preprod.odatano.dev)');
  }
  console.error(`nightgate-mcp: connecting tools to ${config.baseUrl}${config.servicePath}` +
    ` (analytics: ${analytics === 'served' ? `on, ${config.analyticsUrl}` : analytics === 'closed' ? 'closed on the gateway' : 'not served'})`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('nightgate-mcp failed to start:', err);
  process.exit(1);
});
