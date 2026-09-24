import SwaggerParser from '@apidevtools/swagger-parser';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SPEC_URL = process.env.OPENAPI_SPEC_URL || 'https://docs.glomopay.com/openapi.json';
const OUT_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'openapi.json');
const FETCH_TIMEOUT_MS = 15000;

async function main() {
  console.error(`[fetch-spec] fetching ${SPEC_URL}`);

  const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`[fetch-spec] fetch failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  let spec;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    throw new Error(`[fetch-spec] response is not valid JSON: ${error.message}`);
  }

  try {
    await SwaggerParser.validate(JSON.parse(text));
  } catch (error) {
    throw new Error(`[fetch-spec] spec failed OpenAPI validation: ${error.message}`);
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
