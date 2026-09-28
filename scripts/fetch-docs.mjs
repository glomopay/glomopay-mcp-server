import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildCorpus, LLMS_FULL_URL } from '../dist/core/docs/corpus-builder.js';
import { flowGuideFromCorpus, findFlowProblems } from '../dist/core/planner/flow-guide.js';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const OUT_PATH = path.join(DIST, 'docs-corpus.json');
const SPEC_PATH = path.join(DIST, 'openapi.json');

async function specOperations() {
  const spec = JSON.parse(await readFile(SPEC_PATH, 'utf8'));
  const operations = new Map();
  for (const [rawPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (operation?.operationId) operations.set(operation.operationId, { method: method.toUpperCase(), path: rawPath });
    }
  }
  return operations;
}

async function main() {
  console.error(`[fetch-docs] building corpus from ${LLMS_FULL_URL}`);
  const corpus = await buildCorpus();

  const guide = flowGuideFromCorpus(corpus);
  const problems = findFlowProblems(guide, await specOperations());
  if (problems.length > 0) throw new Error(`[fetch-docs] authored flows do not match the spec:\n  ${problems.join('\n  ')}`);

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(corpus));
  const variants = guide.flows.reduce((count, flow) => count + flow.variants.length, 0);
  console.error(`[fetch-docs] wrote ${OUT_PATH} (${corpus.length} pages; ${guide.flows.length} authored flows, ${variants} variants)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
