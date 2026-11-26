import { z } from 'zod';

/** Tool arguments of earlier releases, with what replaced them. */
const FORMER_ARGS: Record<string, string> = {
  compiledArtifactRef: 'renamed to contractName',
  sha256: 'renamed to payloadHash',
  passportId: 'renamed to documentId',
  directed: 'removed: the board lists offers anyone can take',
  takerSecret: 'removed: the board lists offers anyone can take',
};

/** A tool's arguments; an argument the tool does not take is refused instead of dropped. */
export function toolInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      return issue.keys.map((k) => FORMER_ARGS[k] ? `${k} is ${FORMER_ARGS[k]}` : `${k} is not an argument of this tool`).join('; ');
    },
  });
}
