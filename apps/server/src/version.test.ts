import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { VERSION } from './version.js';

const require = createRequire(import.meta.url);

describe('server VERSION', () => {
  // This is the guard the old hard-coded literal never had: it sat at 0.1.0
  // while every manifest said 0.9.0, and it is on the wire in
  // /api/checkconnection, so clients were told the wrong server version.
  it('matches the package manifest', () => {
    const pkg = require('../package.json') as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is a semver triple', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
