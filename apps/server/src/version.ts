import { createRequire } from 'node:module';

/**
 * Server version reported to clients (e.g. `/api/checkconnection`).
 *
 * Read from the package manifest rather than written here as a literal. The
 * literal form drifted eight minors behind — `scripts/bump-version.mjs` rewrites
 * every `package.json` and the `reporter-term` CLI string, but never knew about
 * this file, so nothing kept it honest. Deriving it removes the class of bug
 * instead of fixing one instance.
 *
 * The relative path resolves identically from `src/` under tsx and from the
 * built `dist/` (both are one level below `apps/server`), and the Docker image
 * copies the whole tree, so the manifest is present at runtime in every mode.
 * `version.test.ts` pins the agreement.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
