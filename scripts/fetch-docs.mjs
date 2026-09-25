import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildCorpus, LLMS_URL } from '../dist/core/docs/corpus-builder.js';

const OUT_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'docs-corpus.json');

async function main() {
  console.error(`[fetch-docs] building corpus from ${LLMS_URL}`);
  const corpus = await buildCorpus();
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(corpus));
  console.error(`[fetch-docs] wrote ${OUT_PATH} (${corpus.length} pages)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
