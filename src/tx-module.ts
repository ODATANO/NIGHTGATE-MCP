/**
 * The txbuilder entry of `@odatano/nightgate-tx`, an optional peer the server
 * loads on first use. Every feature names what it needs and the version that
 * carries it, so a missing or old install fails with that instead of a bare
 * resolution error.
 */
let modulePromise: Promise<any> | undefined;

export async function loadTxModule(feature: string, minVersion: string): Promise<any> {
  modulePromise ??= import('@odatano/nightgate-tx/txbuilder').catch((err) => {
    modulePromise = undefined;
    throw new Error(
      `${feature} needs @odatano/nightgate-tx >= ${minVersion} next to the MCP server (npm install @odatano/nightgate-tx): ` +
      (err instanceof Error ? err.message : String(err)),
    );
  });
  return modulePromise;
}

/** One named export of the module; absent = the installed version predates the feature. */
export async function txExport<T>(name: string, feature: string, minVersion: string): Promise<T> {
  const mod = await loadTxModule(feature, minVersion);
  if (typeof mod?.[name] !== 'function') {
    throw new Error(
      `${feature} needs @odatano/nightgate-tx >= ${minVersion}; the installed version has no ${name} (npm install @odatano/nightgate-tx@latest)`,
    );
  }
  return mod[name] as T;
}
