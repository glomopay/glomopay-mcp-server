// Dev tool: records real docs.glomo.one pages into a nock.back cassette so the
// docs_search tests run against real content (replayed in lockdown, no network in
// CI). Re-run manually when the sample pages change:
//   node scripts/record-docs-fixtures.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://docs.glomo.one';
const PAGES = ['/payin/purpose-codes.md', '/platform/webhooks.md'];
const LLMS = `# Glomopay docs

## Payin
Collecting money and the objects it touches.
 - [Purpose Codes](${ORIGIN}/payin/purpose-codes.md)

## Platform
Events and delivery.
 - [Webhooks](${ORIGIN}/platform/webhooks.md)
`;

const OUT = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'cassettes', 'docs-corpus.json');

async function main() {
  const defs = [
    { scope: `${ORIGIN}:443`, method: 'GET', path: '/llms.txt', body: '', status: 200, response: LLMS, rawHeaders: { 'content-type': 'text/plain' }, responseIsBinary: false },
  ];

  for (const page of PAGES) {
    const response = await fetch(ORIGIN + page, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`failed to fetch ${page}: ${response.status}`);
    defs.push({
      scope: `${ORIGIN}:443`,
      method: 'GET',
      path: page,
      body: '',
      status: 200,
      response: await response.text(),
      rawHeaders: { 'content-type': 'text/markdown' },
      responseIsBinary: false,
    });
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(defs, null, 2));
  console.error(`[record-docs-fixtures] wrote ${OUT} (${defs.length} defs)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
