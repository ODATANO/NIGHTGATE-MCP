import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NightgateClient } from './client.js';
import type { NightgateMcpConfig } from './config.js';
import { registerTools } from './tools.js';

/** Build the MCP server with all tools registered; transport is the caller's choice. */
export function buildServer(config: NightgateMcpConfig): McpServer {
  const server = new McpServer({ name: 'nightgate', version: '0.1.0' });
  registerTools(server, new NightgateClient(config));
  return server;
}
