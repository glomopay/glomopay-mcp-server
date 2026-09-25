# glomo MCP server

Stateless Streamable HTTP MCP server that proxies the glomo external API under the
caller's own credential. Tool surface, env vars and deployment are in README.md.

## Commands

- `pnpm build`: tsc + tsc-alias, then fetches the OpenAPI spec into `dist/`. Fails if the spec is unreachable.
- `API_HOST=https://api.glomopay.com pnpm start`
- `pnpm test` (vitest), `pnpm typecheck`, `pnpm exec eslint .`. CI runs all of these plus the build.
- Record a cassette: `NOCK_BACK_MODE=record GLOMO_SANDBOX_TOKEN=<sandbox token> pnpm test`. Default mode is lockdown.

## Architecture decisions

- The spec comes from `https://docs.glomo.one/openapi.json` at build time only. Never vendor it or fetch it at runtime.
- Two generic tools, `glomo_api_read` (GET) and `glomo_api_write` (POST/PATCH/DELETE), take
  `{ operationId, params }`. The split exists so a client can be granted reads without writes.
- `Dispatcher.dispatch` (`src/core/dispatcher/dispatcher.ts`) runs every guard in order: spec lookup,
  allowlist, method-vs-tool, credential, sandbox check on writes, path params. Then it routes params by OpenAPI location.
- Versioned URLs (`spec-index.ts`): the spec server is `/api/v1` but v2 ops are written `/v2/...`, and the
  service mounts `/api/v1` and `/api/v2` as siblings. `API_HOST` is the origin only and each op's full path
  is resolved in the index. Naive concatenation gives `/api/v1/v2/...`.
- `resolveCredential` (`src/features/auth/credential-resolver.ts`) is the only place credentials are read.
  The future token flow replaces that function, not the tools or dispatcher.

## Adding an operation

- Add its `operationId` to `src/features/allowlist/allowlist.config.ts`. It must exist in the published spec.
- Nothing else. GETs become reachable through `glomo_api_read`, writes through `glomo_api_write`.
- Ship the tests with it (see Testing).

## Code conventions

- Import through each folder's `*.module.ts` barrel with the `@/` alias, not the impl files.
- New tools extend `BaseTool` (`src/shared/tool/base-tool.ts`); don't modify the base.
- HTTP-only. No STDIO transport.

## Testing

- Every tool change ships with tests in the same PR, driven through `tools/call` on the real HTTP server (`createApp()`).
- Response content under test comes from recorded sandbox responses (nock.back cassettes). A missing cassette fails CI.
- Hand-coded nock interceptors only assert the outgoing request, or that a refused call never reached the API (empty bodies).
- Every guard has a test that goes red when the guard is removed.
- Use real ID prefixes (`payout_`, `cust_`, ...) and obviously fake test tokens.
- Scrub cassettes of auth, tokens, names, emails, phones, addresses and account numbers before committing.
- Test behaviour, not implementation. Don't test private methods directly.

## Safety invariants

Do not weaken these without an explicit security review.

- The allowlist is the only path to execution. Never add internal, admin, key-rotation or multipart operations.
- Write tools are sandbox-only and fail closed: the token's `env` claim must be exactly `sandbox`.
- Path params are validated against the path template, never interpolated raw.
- One MCP server instance per request.

## Public-repo hygiene

- IMPORTANT: this repo is public. Commits, PR text and review comments describe the fix, not how to exploit it or what data it exposed.
- No internal infrastructure names, backend file paths, credentials, tokens or customer data anywhere, including docs and examples.
  Security detail goes in the internal Jira ticket.

## Naming and PRs

- Tool names use the `glomo_*` prefix (`glomo_api_read`, `glomo_api_write`, `glomo_api_search`, `glomo_api_details`, `glomo_docs_search`, `glomo_implementation_planner`). Wire identifiers stay as they are (`api.glomopay.com`, `X-Glomopay-Signature`).
- PR titles carry the Jira key: `KAN-1234 | Short summary`.
