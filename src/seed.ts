// The caller seed comes from NIGHTGATE_SEED_HEX, else from a file (NIGHTGATE_SEED_FILE).
// The file is created on first use. The tool call that created it says so once.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NightgateMcpConfig } from './config.js';

const SEED_HEX = /^[0-9a-fA-F]{128}$/;

export function defaultSeedFile(): string {
  return join(homedir(), '.nightgate-mcp', 'seed');
}

/** Per tool call: set when this call created the seed file. */
export const seedNotice = new AsyncLocalStorage<{ createdFile?: string }>();

let pending: Promise<string> | null = null;

async function readSeed(file: string): Promise<string | null> {
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read the seed file ${file}: ${(err as Error).message}`);
  }
  if (!SEED_HEX.test(text)) throw new Error(`seed file ${file} must hold 128 hex characters, a 64-byte BIP39 seed`);
  return text.toLowerCase();
}

/** Sets config.seedHex from the environment, the seed file, or a new seed file. */
export async function ensureSeed(config: NightgateMcpConfig): Promise<string> {
  if (config.seedHex) return config.seedHex;
  pending ??= (async () => {
    const file = config.seedFile ?? defaultSeedFile();
    const existing = await readSeed(file);
    if (existing) return existing;
    const seed = randomBytes(64).toString('hex');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      // wx: never overwrite a seed another process wrote in the meantime
      await writeFile(file, seed + '\n', { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const theirs = await readSeed(file);
      if (!theirs) throw err;
      return theirs;
    }
    const store = seedNotice.getStore();
    if (store) store.createdFile = file;
    return seed;
  })();
  try {
    config.seedHex = await pending;
  } finally {
    pending = null;
  }
  return config.seedHex;
}

/** What the call that created the seed file tells the caller. */
export function seedCreated(file: string): Record<string, unknown> {
  return {
    created: true,
    file,
    meaning: 'A new seed was created and saved in this file. It is your identity on Midnight: every record you anchor belongs to it. ' +
      'Keep the file and back it up. Without it nobody can prove claims on or revoke disclosures of these records. ' +
      'To use another seed, set NIGHTGATE_SEED_HEX.',
  };
}
