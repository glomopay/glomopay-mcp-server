import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV3 } from 'openapi-types';

import { THttpMethod } from '@/shared/api-client/api-client.module';

export interface ISpecOperation {
  operationId: string;
  method: THttpMethod;
  path: string;
  pathParams: string[];
  queryParams: string[];
}

export type TSpecIndex = ReadonlyMap<string, ISpecOperation>;

const HTTP_METHODS: THttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const VERSION_SEGMENT = /^\/v\d+\//;

function parseServerPath(document: OpenAPIV3.Document): { prefix: string; defaultVersion: string } {
  const serverUrl = document.servers?.[0]?.url;
  if (!serverUrl) {
    console.error('[spec-index] spec declares no servers; defaulting base path to /api and version v1');
    return { prefix: '/api', defaultVersion: 'v1' };
  }

  let serverPath: string;
  try {
    serverPath = new URL(serverUrl).pathname.replace(/\/$/, '');
  } catch {
    serverPath = serverUrl.replace(/\/$/, '');
  }

  const versioned = serverPath.match(/^(.*)\/(v\d+)$/);
  if (versioned) return { prefix: versioned[1], defaultVersion: versioned[2] };
  return { prefix: serverPath, defaultVersion: '' };
}

// Spec server is /api/v1 but v2 ops are written /v2/...; the service mounts v1 and v2
// as siblings. Keep an explicit /vN/ prefix, otherwise prepend the server's default.
function normalisePath(rawPath: string, prefix: string, defaultVersion: string): string {
  if (VERSION_SEGMENT.test(rawPath)) return `${prefix}${rawPath}`;
  return defaultVersion ? `${prefix}/${defaultVersion}${rawPath}` : `${prefix}${rawPath}`;
}

export async function loadSpecIndex(specFilePath: string): Promise<TSpecIndex> {
  const document = (await SwaggerParser.validate(specFilePath)) as OpenAPIV3.Document;
  const { prefix, defaultVersion } = parseServerPath(document);

  const index = new Map<string, ISpecOperation>();
  for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method.toLowerCase() as OpenAPIV3.HttpMethods];
      if (!operation || !operation.operationId) continue;

      // Parameters may be declared on the path item (shared) or the operation.
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])] as OpenAPIV3.ParameterObject[];

      index.set(operation.operationId, {
        operationId: operation.operationId,
        method,
        path: normalisePath(rawPath, prefix, defaultVersion),
        pathParams: parameters.filter((p) => p.in === 'path').map((p) => p.name),
        queryParams: parameters.filter((p) => p.in === 'query').map((p) => p.name),
      });
    }
  }

  return index;
}
