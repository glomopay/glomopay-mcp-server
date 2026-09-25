import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SPEC_URL = process.env.OPENAPI_SPEC_URL ?? 'https://docs.glomo.one/openapi.json';
const KEEP_OPERATION_IDS = [
  'createPayout',
  'getPayments',
  'createBeneficiaryV2',
  'getBeneficiaryByIdV2',
  'cancelPayout',
  'getCustomers',
];
const OFF_SURFACE_CANDIDATES = ['rotateApiKey', 'onboardMerchant', 'updateMerchant', 'createDocument'];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outPath = path.join(repoRoot, 'test/fixtures/openapi-discovery.json');

function readAllowlist() {
  const source = readFileSync(path.join(repoRoot, 'src/features/allowlist/allowlist.config.ts'), 'utf8');
  const start = source.indexOf('= [');
  const block = source.slice(start, source.indexOf(']', start));
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const PII_KEY = /name|email|phone|mobile|address|city|postal|zip|account.*number|\biban\b|routing|swift|ifsc|\bpan\b|\bcvv\b/i;
const DATA_KEYS = new Set(['example', 'examples', 'default']);

function scrubData(value) {
  if (typeof value === 'string') return value.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, 'redacted@example.com');
  if (Array.isArray(value)) return value.map(scrubData);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = PII_KEY.test(key) && typeof val === 'string' ? 'REDACTED' : scrubData(val);
    }
    return out;
  }
  return value;
}

// Only example/examples/default hold sample data that can carry PII. Everything
// else is API structure (parameter names, property keys) and must be preserved.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = DATA_KEYS.has(key) ? scrubData(val) : scrub(val);
    }
    return out;
  }
  return value;
}

function collectRefs(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === '$ref' && typeof val === 'string' && val.startsWith('#/components/')) acc.add(val);
    else collectRefs(val, acc);
  }
}

function componentAt(spec, ref) {
  const [, , section, name] = ref.split('/');
  return { section, name, value: spec.components?.[section]?.[name] };
}

const raw = await (await fetch(SPEC_URL)).json();
const allowlist = readAllowlist();

const keptPaths = {};
const operationByPath = {};
for (const [p, item] of Object.entries(raw.paths ?? {})) {
  for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    const op = item[method];
    if (!op?.operationId) continue;
    operationByPath[op.operationId] = { p, method, item, op };
  }
}

const offSurface = OFF_SURFACE_CANDIDATES.find((id) => operationByPath[id] && !allowlist.has(id));
if (!offSurface) throw new Error('no off-surface operation found in the spec among candidates');
const keep = [...KEEP_OPERATION_IDS, offSurface];

for (const id of keep) {
  const found = operationByPath[id];
  if (!found) throw new Error(`operation ${id} not found in spec`);
  keptPaths[found.p] ??= {};
  keptPaths[found.p][found.method] = found.op;
  if (found.item.parameters) keptPaths[found.p].parameters = found.item.parameters;
}

const RECURSIVE = {
  type: 'object',
  description: 'Synthetic self-referential schema for the cycle-guard test.',
  'x-internal': true,
  properties: {
    label: { type: 'string' },
    child: { $ref: '#/components/schemas/RecursiveProbe' },
  },
};
keptPaths['/payouts/{id}/cancel'].patch.responses['200'].content = {
  'application/json': { schema: { type: 'object', properties: { _recursiveProbe: { $ref: '#/components/schemas/RecursiveProbe' } } } },
};

const refs = new Set();
collectRefs(keptPaths, refs);
const components = { schemas: { RecursiveProbe: RECURSIVE } };
const queue = [...refs];
const seen = new Set(['#/components/schemas/RecursiveProbe']);
while (queue.length) {
  const ref = queue.shift();
  if (seen.has(ref)) continue;
  seen.add(ref);
  const { section, name, value } = componentAt(raw, ref);
  if (value === undefined) throw new Error(`unresolved component ${ref}`);
  components[section] ??= {};
  components[section][name] = value;
  const nested = new Set();
  collectRefs(value, nested);
  for (const r of nested) if (!seen.has(r)) queue.push(r);
}

const fixture = scrub({
  openapi: raw.openapi ?? '3.1.0',
  info: { title: 'glomo discovery test fixture', version: '1.0.0' },
  servers: raw.servers,
  paths: keptPaths,
  components,
});

writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
console.error(
  `Wrote ${outPath}: ${keep.length} operations (off-surface: ${offSurface}), ` +
    `${Object.keys(components.schemas).length} schemas, ${Math.round(readFileSync(outPath).length / 1024)} KB`,
);
