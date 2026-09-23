import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NightgateClient } from './client.js';
import type { NightgateMcpConfig } from './config.js';
import { registerTools } from './tools.js';
import { registerAnalyticsTools } from './analytics.js';

export interface Capabilities {
  /** True when the host serves ODATANO ASTRA (analytics) next to NIGHTGATE; see NightgateClient.analyticsStatus. */
  analytics: boolean;
}

/**
 * Build the MCP server with all tools registered; transport is the caller's
 * choice. `caps` defaults to "NIGHTGATE only" so callers that cannot reach the
 * host (schema inspection, tests) get a deterministic tool set.
 */
export function buildServer(config: NightgateMcpConfig, caps: Capabilities = { analytics: false }): McpServer {
  const server = new McpServer({ name: 'nightgate', version: '0.8.0' });
  const client = new NightgateClient(config);
  registerTools(server, client, config);
  if (caps.analytics) registerAnalyticsTools(server, client);
  return server;
}
