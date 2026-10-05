import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LLMS_FULL_URL, SKILLS_INDEX_URL, SKILLS_SECTION } from '../dist/core/docs/corpus-builder.js';
import { buildCheckedCorpus, specOperations } from '../dist/core/planner/flow-guide.js';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const OUT_PATH = path.join(DIST, 'docs-corpus.json');
const SPEC_PATH = path.join(DIST, 'openapi.json');

async function main() {
  console.error(`[fetch-docs] building corpus from ${LLMS_FULL_URL} and ${SKILLS_INDEX_URL}`);
  const spec = JSON.parse(await readFile(SPEC_PATH, 'utf8'));
  const { corpus, guide } = await buildCheckedCorpus(specOperations(spec));

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(corpus));
  const variants = guide.flows.reduce((count, flow) => count + flow.variants.length, 0);
  const skills = corpus.filter((page) => page.section === SKILLS_SECTION).length;
  console.error(
    `[fetch-docs] wrote ${OUT_PATH} (${corpus.length - skills} docs pages, ${skills} skills; ${guide.flows.length} authored flows, ${variants} variants)`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
