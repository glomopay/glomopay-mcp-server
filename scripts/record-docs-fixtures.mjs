// Dev tool: records a real subset of docs.glomo.one/llms-full.txt into a nock.back
// cassette so the docs_search tests run against real content (replayed in lockdown,
// no network in CI). Re-run manually when the sample pages change:
//   node scripts/record-docs-fixtures.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://docs.glomo.one';
const LLMS_FULL = `${ORIGIN}/llms-full.txt`;
const KEEP = [
  `${ORIGIN}/get-started`,
  `${ORIGIN}/payin`,
  `${ORIGIN}/payin/purpose-codes`,
  `${ORIGIN}/payout/purpose-codes`,
  `${ORIGIN}/platform/webhooks`,
];

const OUT = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'cassettes', 'docs-corpus.json');

// Slice the full file into [preamble, ...page blocks], each block starting at its
// `Source:` line, then keep the preamble plus the blocks whose URL is in KEEP.
function subset(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (/^Source:\s+\S+\s*$/.test(line)) starts.push(i);
  });
  const preamble = lines.slice(0, starts[0]).join('\n');
  const blocks = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(start, end);
    const url = block[0].replace(/^Source:\s+/, '').trim();
    return { url, text: block.join('\n') };
  });
  const kept = KEEP.map((url) => blocks.find((block) => block.url === url));
  const missing = KEEP.filter((url, i) => !kept[i]);
  if (missing.length) throw new Error(`pages missing from llms-full.txt: ${missing.join(', ')}`);
  return [preamble, ...kept.map((block) => block.text)].join('\n');
}

async function main() {
  const response = await fetch(LLMS_FULL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`failed to fetch ${LLMS_FULL}: ${response.status}`);

  const defs = [
    {
      scope: `${ORIGIN}:443`,
      method: 'GET',
      path: '/llms-full.txt',
      body: '',
      status: 200,
      response: subset(await response.text()),
      rawHeaders: { 'content-type': 'text/plain; charset=utf-8' },
      responseIsBinary: false,
    },
  ];

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(defs, null, 2));
  console.error(`[record-docs-fixtures] wrote ${OUT} (${(defs[0].response.length / 1024) | 0} KB)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
