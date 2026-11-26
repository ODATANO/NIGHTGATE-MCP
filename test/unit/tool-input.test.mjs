// Tool arguments: an argument a tool does not take is refused, a former one names its successor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { toolInput } from '../../dist/tool-input.js';

const schema = toolInput({ contractName: z.string().optional() });

test('a former argument names what replaced it', () => {
  const result = schema.safeParse({ compiledArtifactRef: 'attestation-vault' });
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].message, 'compiledArtifactRef is renamed to contractName');
});

test('an unknown argument is refused, a known one passes', () => {
  assert.match(schema.safeParse({ contractname: 'x' }).error.issues[0].message, /contractname is not an argument of this tool/);
  assert.deepEqual(schema.parse({ contractName: 'attestation-vault' }), { contractName: 'attestation-vault' });
});

test('the quick start pins the version this package carries', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const named = [...readme.matchAll(/@odatano\/nightgate-mcp(@[\w.-]+)?(?=["`\s])/g)].filter((m) => /npx|"args"/.test(readme.slice(m.index - 40, m.index)));
  assert.ok(named.length >= 2, 'the README starts the server with npx');
  for (const m of named) assert.equal(m[1], `@${version}`, `README: "${m[0]}"`);
});
