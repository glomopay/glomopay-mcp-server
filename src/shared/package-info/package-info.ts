import { readFileSync } from 'node:fs';
import path from 'node:path';

// Same depth under src/ and dist/, so this resolves to the repo root in both.
const PACKAGE_JSON = path.resolve(__dirname, '../../../package.json');

function readVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
    return version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const packageVersion = readVersion();
