#!/usr/bin/env node
/**
 * Drive the MCP server from a terminal, without an LLM in the loop. Spawns
 * `dist/index.js` over stdio exactly like a real client, so what you see
 * here is what an agent sees.
 *
 *   npm run mcp -- list                       # tool names
 *   npm run mcp -- schema verify_attestation  # its input schema
 *   npm run mcp -- call verify_attestation '{"contractAddress":"...","payloadHash":"..."}'
 *   npm run mcp -- call prepare_document_proof @args.json   # @file reads JSON from disk
 *
 * Config comes from .env (see .env.example). Exit code is 0 on success and
 * 1 when the tool reports an error, so it composes in a shell.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, name, rawArgs] = process.argv.slice(2);

if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
  console.log('usage: npm run mcp -- <list | schema <tool> | call <tool> [json|@file]>');
  process.exit(cmd ? 0 : 1);
}

// Only NIGHTGATE_* reaches the child, the same handover an MCP client's
// `env` block performs.
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('NIGHTGATE_') && v) env[k] = v;

const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'index.js')], env });
const client = new Client({ name: 'mcp-cli', version: '0' });
await client.connect(transport);

const finish = async (code) => { await client.close(); process.exit(code); };

if (cmd === 'list') {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name.padEnd(32), String(t.description ?? '').split('. ')[0].slice(0, 90));
  console.log(`\n${tools.length} tools`);
  await finish(0);
}

if (!name) { console.error(`'${cmd}' needs a tool name`); await finish(1); }

if (cmd === 'schema') {
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === name);
  if (!t) { console.error(`unknown tool '${name}'`); await finish(1); }
  console.log(JSON.stringify(t.inputSchema, null, 2));
  await finish(0);
}

if (cmd === 'call') {
  let args = {};
  if (rawArgs) {
    const text = rawArgs.startsWith('@') ? readFileSync(rawArgs.slice(1), 'utf8') : rawArgs;
    try { args = JSON.parse(text); } catch (e) { console.error(`arguments must be JSON: ${e.message}`); await finish(1); }
  }
  // Generous: a first local build downloads prover keys before it proves,
  // far past the protocol's own 60 s default.
  const timeout = Number(process.env.NIGHTGATE_MCP_CALL_TIMEOUT_MS || 900_000);
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  await finish(r.isError ? 1 : 0);
}

console.error(`unknown command '${cmd}'`);
await finish(1);
