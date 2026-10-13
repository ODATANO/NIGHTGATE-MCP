// Built transaction bytes stay in this process or in a file; a tool argument carries their id or path.
// A model reproducing 16,000 base64 characters verbatim drops some, and the sponsor reads a damaged transaction.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What was built or sent: `txId` is the sha256 of the bytes, so both ends compare one value. */
export interface TxBytesInfo {
  txId: string;
  characters: number;
  bytes: number;
}

const HOLD_MS = 60 * 60 * 1000;
const HOLD_MAX = 64;
const held = new Map<string, { b64: string; at: number }>();

export function describeTx(b64: string): TxBytesInfo {
  const bytes = Buffer.from(b64, 'base64');
  return { txId: createHash('sha256').update(bytes).digest('hex'), characters: b64.length, bytes: bytes.length };
}

/** Keeps the bytes for one transaction TTL, at most HOLD_MAX at a time. */
export function holdBuilt(b64: string): TxBytesInfo {
  const info = describeTx(b64);
  const now = Date.now();
  for (const [id, entry] of held) if (now - entry.at > HOLD_MS) held.delete(id);
  while (held.size >= HOLD_MAX) held.delete(held.keys().next().value as string);
  held.set(info.txId, { b64, at: now });
  return info;
}

export function heldTx(txId: string): string {
  const entry = held.get(txId);
  if (!entry) throw new Error(`no transaction with txId ${txId} is held by this server process: build it again, or pass its file`);
  return entry.b64;
}

const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/;

/** A file holding the transaction as base64 text or as the raw bytes. */
export async function readTxFile(path: string): Promise<string> {
  let raw: Buffer;
  try { raw = await readFile(path); }
  catch (err) { throw new Error(`transaction file ${path} is not readable: ${(err as Error).message}`); }
  if (raw.length === 0) throw new Error(`transaction file ${path} is empty`);
  const text = raw.toString('latin1');
  return BASE64_TEXT.test(text) ? text.replace(/\s+/g, '') : raw.toString('base64');
}

export async function writeTxFile(path: string, b64: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, b64, { mode: 0o600 });
}

export interface TxSource {
  txId?: string;
  file?: string;
  b64?: string;
}

/** Exactly one source names the bytes. The base64 argument is kept for callers without a file. */
export async function resolveTxSource(source: TxSource, b64Name: string): Promise<{ b64: string; sent: TxBytesInfo }> {
  const given = [source.txId, source.file, source.b64].filter((v) => v !== undefined && v !== '').length;
  if (given !== 1) throw new Error(`pass exactly one of txId, file or ${b64Name}`);
  const b64 = source.txId ? heldTx(source.txId) : source.file ? await readTxFile(source.file) : String(source.b64);
  return { b64, sent: describeTx(b64) };
}
