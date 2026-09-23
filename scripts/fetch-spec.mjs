// Build-time fetch of the published Glomopay OpenAPI spec into dist/. The spec is
// never vendored and never fetched at runtime, so the tool surface cannot drift
// from the documented API. A failed/invalid fetch fails the build.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SPEC_URL = process.env.OPENAPI_SPEC_URL || 'https://docs.glomopay.com/openapi.json';
const OUT_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'openapi.json');

async function main() {
  console.error(`[fetch-spec] fetching ${SPEC_URL}`);

  const response = await fetch(SPEC_URL);
  if (!response.ok) {
    throw new Error(`[fetch-spec] fetch failed: ${response.status} ${response.statusText}`);
  }

  let spec;
  try {
    spec = JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`[fetch-spec] response is not valid JSON: ${error.message}`);
  }

  const operationCount = countOperations(spec);
  if (operationCount === 0) {
    throw new Error('[fetch-spec] parsed spec has zero operations — refusing to ship it');
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(spec, null, 2));

  console.error(`[fetch-spec] wrote ${OUT_PATH} (${operationCount} operations)`);
}

function countOperations(spec) {
  const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  let count = 0;
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem ?? {})) {
      if (httpMethods.has(method.toLowerCase())) count += 1;
    }
  }
  return count;
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
