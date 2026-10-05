# Glomo MCP server

Stateless Streamable HTTP MCP server that proxies the Glomo external API under the
caller's own credential. Tool surface, env vars and deployment are in README.md.

## Commands

- `pnpm build`: tsc + tsc-alias, then fetches the OpenAPI spec into `dist/`. Fails if the spec is unreachable.
- `API_HOST=https://api.glomopay.com pnpm start`
- `pnpm test` (vitest), `pnpm typecheck`, `pnpm exec eslint .`. CI runs all of these plus the build.
- Record a cassette: `NOCK_BACK_MODE=record GLOMO_SANDBOX_TOKEN=<sandbox token> pnpm test`. Default mode is lockdown.

## Architecture decisions

- The spec comes from `https://docs.glomo.one/openapi.json` at build time only. Never vendor it or fetch it at runtime.
- Two generic tools, `glomo_api_read` (GET) and `glomo_api_write` (POST/PATCH/DELETE), take
  `{ operationId, params }`. The split exists so a client can later be granted reads without writes (every
  credential is read_write for now).
- `Dispatcher.dispatch` (`src/core/dispatcher/dispatcher.ts`) runs every guard in order: spec lookup,
  allowlist, method-vs-tool, credential verification, sandbox check, path params. Then it
  routes params by OpenAPI location.
- Versioned URLs (`spec-index.ts`): the spec server is `/api/v1` but v2 ops are written `/v2/...`, and the
  service mounts `/api/v1` and `/api/v2` as siblings. `API_HOST` is the origin only and each op's full path
  is resolved in the index. Naive concatenation gives `/api/v1/v2/...`.
- `glomo_implementation_planner` returns authored flows only, parsed from the docs Get started page
  (`src/core/planner/flow-guide.ts`). Never derive a call order from the spec. The step format is closed: a
  step that matches neither form, or names an operation the spec doesn't have, fails `pnpm build`.
- `CredentialVerifier` (`src/features/auth/credential-resolver.ts`) is the only place credentials are verified.
  It verifies the agent credential (RS256 signature against the configured public key, `aud` = MCP audience,
  `exp`/`iat` required) and returns its `env`/`sub`; the dispatcher enforces the sandbox rule. The public
  key and audience come from env
  (`GLOMO_MCP_PUBLIC_KEY`, `GLOMO_MCP_AUDIENCE`); no private key lives on this service. `iss` is not checked;
  `aud` alone identifies the credential. There is no `scope` or `purpose` claim: every credential is
  read_write until access is split (a separate change).
- Telemetry (`src/core/telemetry`, `src/core/analytics`) watches each transport's JSON-RPC traffic, so tools never
  emit events. A tool reports what it knows about its own call with `reportToolCall` (`operationId`, `httpStatus`,
  `resultCount`, `searchQuery`, `errorCode`, `pathTemplate`); nothing else can reach Mixpanel or a span. Every
  `isError` path reports an `errorCode` from the fixed list in `error-code.ts` (listed in README.md, Telemetry). Env vars (`MIXPANEL_*`,
  `DEPLOYMENT_ENVIRONMENT`, `OTEL_*`) are in README.md.
- A write that gets no response (timeout, dropped connection) returns an "outcome unknown" error telling the agent
  to look the resource up before retrying and never to retry with a new request_id.
- Attribution (`merchant_id`, `environment`, the audit `merchantId`) comes only from `CredentialVerifier`'s verified
  `sub`/`env`. The dispatcher reports `caller` where it verifies; for a call it never verified, the observer runs
  the same verifier once. Never decode a token for attribution.
- `search_query` keeps redacted free text by product decision. The redactor does not catch names or IDs shorter
  than 9 digits; that is accepted residual risk (README.md, Telemetry).
- Mixpanel properties are snake_case; OTel span, metric and log attributes are camelCase. Log through
  `@/shared/logger/logger.module`, not `console`.

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
- Mixpanel is asserted with nock interceptors on its API host (`captureMixpanel` in `test/helpers.ts`). Never record a
  cassette against Mixpanel. OTel is asserted with the SDK's in-memory exporters (`test/otel-setup.ts`, imported first).
- Upstream statuses, timeouts and dropped connections come from a real local server (`startBrokenUpstream` in
  `test/helpers.ts`), not from hand-written nock replies.
- Every guard has a test that goes red when the guard is removed.
- HTTP-surface behaviour (error shape, limits, client address, `/healthz`) is tested with raw POSTs in
  `test/http-hardening.test.ts`. `startTestServer` sets limits no suite reaches; pass `rateLimit` to test them.
- Use real ID prefixes (`payout_`, `cust_`, ...) and obviously fake test tokens.
- Scrub cassettes of auth, tokens, names, emails, phones, addresses and account numbers before committing.
- Test behaviour, not implementation. Don't test private methods directly.

## Safety invariants

Do not weaken these without an explicit security review.

- The allowlist is the only path to execution. Never add internal, admin, key-rotation or multipart operations.
- Execution credentials are verified, never passed through unchecked: RS256 signature, `aud` = MCP audience,
  algorithm pinned to RS256, `exp`/`iat` required. Missing or unconfigured verification fails execution
  closed; discovery stays reachable.
- Execution tools are sandbox-only and fail closed: the credential's `env` claim must be exactly `sandbox`.
- Path params are validated against the path template, never interpolated raw.
- One MCP server instance per request.
- `trust proxy` is an explicit hop count from `TRUST_PROXY_HOPS`, never `true`: a client controls the left of
  `X-Forwarded-For`. The app refuses to start on Render without it.
- Requests rejected before the MCP transport (bad body, rate limit) never reach analytics; they are counted in
  `mcp.http.rejected` only, with no client address, credential or path as an attribute.
- Rate limits key a caller on the merchant (`sub`) only after `CredentialVerifier` accepts its credential;
  anything unverified is keyed by client address. Never key on a raw or decoded-but-unverified bearer, so a
  made-up token can't mint a bucket. The key stays in memory and never reaches a log or metric.

## Public-repo hygiene

- IMPORTANT: this repo is public. Commits, PR text and review comments describe the fix, not how to exploit it or what data it exposed.
- No internal infrastructure names, backend file paths, credentials, tokens or customer data anywhere, including docs and examples.
  Security detail goes in the internal Jira ticket.

## Naming and PRs

- Prose writes the company name as "Glomo" (capital G): tool titles and descriptions, messages, docs and comments.
  Identifiers keep their existing case.
- Tool names use the `glomo_*` prefix (`glomo_api_read`, `glomo_api_write`, `glomo_api_search`, `glomo_api_details`, `glomo_docs_search`, `glomo_sample_request`, `glomo_implementation_planner`). Wire identifiers stay as they are (`api.glomopay.com`, `X-Glomopay-Signature`).
- PR titles carry the Jira key: `KAN-1234 | Short summary`.
