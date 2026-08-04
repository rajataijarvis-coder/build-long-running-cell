import { createRequire } from 'module';

/**
 * Runtime version of the cell package.
 *
 * This is read from `cell/package.json` so operators can correlate running
 * instances with source code. It is used by the /health and /version HTTP
 * endpoints and by the dashboard deployment panel.
 */
export const CELL_VERSION: string = (() => {
  try {
    // `import.meta.url` points at the compiled .js file inside dist/ at runtime,
    // so `../package.json` resolves to cell/package.json.
    return createRequire(import.meta.url)('../package.json').version as string;
  } catch {
    return 'unknown';
  }
})();
