# Glomopay MCP Server

An MCP (Model Context Protocol) server that exposes the Glomopay external API to
AI agents. It presents a small, generic tool surface backed by a reviewed
allowlist, and proxies calls to the Glomopay REST API on behalf of the caller.

The server is built from the published OpenAPI spec at
`https://docs.glomo.one/openapi.json` — the same contract the public docs are
generated from. The spec is fetched at **build time** and baked into the image;
it is never vendored into the repository and never fetched at runtime, so the
tool surface cannot drift from the documented API.

## Tool surface

Discovery is exposed through four credential-free tools:

| Tool                           | Description                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `glomo_api_search`             | Find the right operation by keyword; returns ranked `operationId`/method/path.                           |
| `glomo_api_details`            | Return full parameter and request/response schema detail for given `operationId`s.                       |
| `glomo_sample_request`         | Generate a ready-to-run cURL / Python / Node sample for an operation from its schema.                    |
| `glomo_implementation_planner` | Placeholder: returns guidance to `glomo_docs_search` and the published skills until authored flows land. |

Execution is exposed through two generic tools:

| Tool              | Methods           | Description                                 |
| ----------------- | ----------------- | ------------------------------------------- |
| `glomo_api_read`  | GET               | Run a read-only operation by `operationId`. |
| `glomo_api_write` | POST/PATCH/DELETE | Run a write operation by `operationId`.     |

The discovery tools let an agent locate the right `operationId`, inspect its
schema, and get a ready-to-run sample before calling it. They index the whole
published OpenAPI spec and mark each operation with an `executable` flag:
allowlisted operations carry the tool that runs them
(`glomo_api_read`/`glomo_api_write`), and the rest are returned as documentation
only (`executable: false`) so an agent can still read their schema without being
able to run them. `glomo_sample_request` renders the credential as a
`$GLOMO_API_KEY` placeholder. `glomo_implementation_planner` is a registered
placeholder that points callers to `glomo_docs_search` and the published skills
until authored per-flow call sequences land. None of the discovery tools need a
credential — they run unauthenticated (see below).

Both execution tools take an `operationId` (from the OpenAPI spec, e.g.
`createCustomer`) and a flat `params` object. The dispatcher resolves the
operation against the spec, enforces the allowlist, splits `params` into path /
query / body by their real OpenAPI location, injects the caller's credential and
proxies the request.

Read and write are separate tools so a client can be granted discovery and reads
without granting writes. Both are gated by the same allowlist
(`src/features/allowlist/allowlist.config.ts`), which is reviewed config keyed by
`operationId` — operations added to the spec later are not reachable until a
human adds them.

## Transport & authentication

The server runs as a **stateless Streamable HTTP** service. The only route is
`POST /mcp`; `GET`/`DELETE` return `405`.

A credential is required only for the execution tools (`glomo_api_read`,
`glomo_api_write`). `tools/list` and every discovery tool run unauthenticated, so
an agent can find and inspect operations before it holds a key.

The execution credential is an expiring, MCP-audience token issued by glomo, not
a merchant API key. When one is present as `Authorization: Bearer <token>`, the
server verifies its RS256 signature against the configured glomo public key,
and requires its `aud` claim to equal the configured MCP audience; anything else — an
unsigned, tampered, or expired token, the wrong algorithm, or a merchant key minted
for the external API — is rejected before any downstream call. (`iss` is not checked;
`aud` alone identifies the credential.) Every credential currently grants both reads
and writes — there is no `scope` claim yet — and both execution tools are
sandbox-only: the credential's `env` claim must be exactly `sandbox`, or the call is
refused before any downstream request. A request with no credential still reaches
discovery and `tools/list`; the execution tools fail closed. The server holds no private key.
Verification is isolated behind a single seam
(`src/features/auth/credential-resolver.ts`).

## Configuration

Environment variables:

| Variable               | Default        | Description                                                     |
| ---------------------- | -------------- | --------------------------------------------------------------- |
| `API_HOST`             | —              | API origin, e.g. `https://api.glomopay.com`.                    |
| `PORT`                 | `3000`         | Port to listen on.                                              |
| `HOST`                 | `127.0.0.1`    | Bind address.                                                   |
| `GLOMO_MCP_PUBLIC_KEY` | —              | PEM (SPKI) public key the agent credential is verified against. |
| `GLOMO_MCP_AUDIENCE`   | —              | Expected `aud` claim on the agent credential.                   |
| `OPENAPI_SPEC_URL`     | docs.glomo.one | Build-time spec source (overridable for CI/testing).            |

Without `GLOMO_MCP_PUBLIC_KEY` and `GLOMO_MCP_AUDIENCE`, the execution tools fail
closed (every credential is rejected); discovery still works.

`API_HOST` is the origin only — the versioned base path (`/api/v1`, `/api/v2`) is
resolved per operation from the spec.

### Telemetry

All telemetry is off unless configured, so local runs, CI and tests send nothing.

| Variable                      | Default            | Description                                                                                                                        |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MIXPANEL_TOKEN`              | —                  | Mixpanel project token. Unset: product analytics is a no-op.                                                                       |
| `MIXPANEL_HOST`               | `api.mixpanel.com` | Mixpanel ingestion host (or full origin), e.g. for a regional data-residency endpoint.                                             |
| `GLOMO_JWT_PUBLIC_KEY`        | —                  | PEM public key for glomo API keys. Set: a key is attributed only if its RS256 signature verifies. Unset: claims are decoded as-is. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —                  | OTLP/HTTP collector base URL. Unset: OpenTelemetry is not started.                                                                 |
| `OTEL_EXPORTER_OTLP_HEADERS`  | —                  | Headers sent with every OTLP export, e.g. `authorization=Bearer <token>`.                                                          |

- **Product analytics (Mixpanel).** `mcp_session_submitted` on `initialize`, `mcp_tool_submitted` on every
  `tools/call` (`status` = `success`/`failed`), and `mcp_tool_failed` with an `error_code` when a call fails.
  Events are batched and fire-and-forget over the `/track` endpoint, with at most 4 requests in flight, a
  10 s timeout per request and a bounded queue; anything undeliverable is counted in `mcp.analytics.dropped`.
  A Mixpanel failure never affects a tool response, and IP geolocation is off. `distinct_id` is the API key's
  `sub`; calls with no readable key are sent with an empty `distinct_id`. The only tool inputs sent are
  `operation_id` and redacted search text (`search_query`, from `glomo_api_search`, `glomo_docs_search` and the
  `glomo_implementation_planner` goal); arguments, bodies and tokens are never sent.
- **Traces, metrics and logs (OpenTelemetry, `service.name` = `glomo-mcp-server`).** One span per
  `tools/call` with a child span for the downstream API call, whose URL is recorded as the operation's path
  template (never the concrete path or query). Incoming HTTP requests are not traced. `mcp.tool.calls`,
  `mcp.tool.duration` and `mcp.analytics.dropped` metrics; JSON logs on stdout carrying the trace context, also
  exported over OTLP. Each `glomo_api_write` call writes one audit log line (merchant, operation, HTTP status and
  the downstream request ID; never bodies). The span's `mcpRequestId` equals the Mixpanel `mcp_request_id`.

## Development

Prerequisites: Node.js 22+, pnpm 10.10.0.

```bash
pnpm install
pnpm build        # tsc + tsc-alias, then fetches the spec into dist/
API_HOST=https://api.glomopay.com pnpm start
```

`pnpm build` fails if the spec cannot be fetched or parsed, so a broken or
unreachable spec never ships.

### Smoke test

`tools/list` needs no credential:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deployment

Deployed as a web service on Render, auto-deploying from `main`. See
`render.yaml`. `API_HOST` is set in the Render dashboard (`sync: false`).

## Security

Execution tools are sandbox-only and fail closed: the credential's `env` claim must
be exactly `sandbox`.

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities. Do not commit
secrets, API keys, or JWTs to this repository.
