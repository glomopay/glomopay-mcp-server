# Glomo MCP Server

An MCP (Model Context Protocol) server that exposes the Glomo external API to
AI agents. It presents a small, generic tool surface backed by a reviewed
allowlist, and proxies calls to the Glomo REST API on behalf of the caller.

The server is built from the published OpenAPI spec at
`https://docs.glomo.one/openapi.json` — the same contract the public docs are
generated from. The spec is fetched at **build time** and baked into the image;
it is never vendored into the repository and never fetched at runtime, so the
tool surface cannot drift from the documented API.

## Tool surface

Discovery is exposed through four credential-free tools:

| Tool                           | Description                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `glomo_api_search`             | Find the right operation by keyword; returns ranked `operationId`/method/path.                               |
| `glomo_api_details`            | Return full parameter and request/response schema detail for given `operationId`s.                           |
| `glomo_sample_request`         | Generate a ready-to-run cURL / Python / Node sample for an operation from its schema.                        |
| `glomo_implementation_planner` | Return the authored, ordered call sequence for an integration flow, verbatim from the docs Get started page. |

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
`$GLOMO_API_KEY` placeholder. `glomo_implementation_planner` reads the flows
authored under "What are you building?" on the docs Get started page, from the same
docs corpus `glomo_docs_search` uses. Given a `flow` id it returns every variant's
steps in order, verbatim, each API step flagged `executable` with its tool, plus the
variant's full guide link. Given a free-text `goal` it returns the best-matching
flows to choose from, never a plan, so it cannot guess one. The build fails if a
step breaks the step format or names an `operationId`, method or path that the
spec doesn't have; if the page can't be parsed at runtime, the planner reports
`not_available`. None of the discovery tools need a credential — they run
unauthenticated (see below).

`glomo_docs_search` searches the docs pages listed in `https://docs.glomo.one/llms.txt`
(full text from `llms-full.txt`) and the published Glomo agent skills listed in
`https://docs.glomo.one/.well-known/skills/index.json`. Each skill is indexed as its own
page under the "Skills" section, titled with the skill name and cited with its
published `SKILL.md` URL; its YAML frontmatter is not indexed. Both are fetched at
build time from docs.glomo.one only. The build fails if the docs pages don't match
`llms.txt`, if the skills index is unreachable or empty, or if a listed skill's
`SKILL.md` is missing or names a different skill. The skills are not part of the
`llms.txt` check.

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

The server runs as a **stateless Streamable HTTP** service. The MCP route is
`POST /mcp`, one JSON-RPC message per request; `GET`/`DELETE` return `405`.
`GET /healthz` answers `200 {"status":"ok"}` for the host's health check; it
touches neither the docs corpus nor the API.

Every request the server turns away gets a JSON-RPC error with no `id`, the
shape the MCP SDK uses for its own transport errors, and never a stack trace or
file path:

| Condition                                                                                    | HTTP  | JSON-RPC code |
| -------------------------------------------------------------------------------------------- | ----- | ------------- |
| Malformed JSON                                                                               | `400` | `-32700`      |
| Not a single JSON-RPC message (JSON-RPC batches are refused, as MCP 2025-06-18 dropped them) | `400` | `-32600`      |
| Body over 100 KB (for every accepted Content-Type)                                           | `413` | `-32000`      |
| Content-Type without `application/json`                                                      | `415` | `-32000`      |
| Rate limited (see below)                                                                     | `429` | `-32000`      |

A credential is required only for the execution tools (`glomo_api_read`,
`glomo_api_write`). `tools/list` and every discovery tool run unauthenticated, so
an agent can find and inspect operations before it holds a key.

The execution credential is an expiring, MCP-audience token issued by Glomo, not
a merchant API key. When one is present as `Authorization: Bearer <token>`, the
server verifies its RS256 signature against the configured Glomo public key,
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

### Rate limits

Three limits, each counted per minute (client addresses group IPv6 by /56):

- **Flood guard**, every request to `/mcp` per client address, verified or not,
  before the body is read: `RATE_LIMIT_FLOOD_PER_MINUTE` (1200).
- **Per caller**, every request:
  - a caller whose credential passes verification is budgeted per merchant (the
    credential's `sub`), wherever it calls from: `RATE_LIMIT_MERCHANT_PER_MINUTE`
    (600). Its address budget does not apply.
  - anyone else (no credential, or one that fails verification) is budgeted per
    client address: `RATE_LIMIT_PER_MINUTE` (300). A made-up token never earns a
    budget of its own.
  - Addresses in `RATE_LIMIT_SHARED_EGRESS_CIDRS` get
    `RATE_LIMIT_SHARED_EGRESS_PER_MINUTE` (3000) instead of the per-address and
    flood limits: hosted MCP clients such as claude.ai send every user's calls
    from a few shared addresses. The default ranges are Anthropic's published
    egress ranges (https://platform.claude.com/docs/en/api/ip-addresses).
- **Execution** calls (`glomo_api_read`, `glomo_api_write`), additionally:
  `RATE_LIMIT_EXECUTION_PER_MINUTE` (60), keyed the same way (per merchant, or
  per address without a verified credential).

A limited request gets `429` with `Retry-After` and the `RateLimit` /
`RateLimit-Policy` headers (IETF draft 8). Counters are in memory, which is exact
for one instance; with more than one instance each counts separately, so a
shared store is needed before scaling out. All execution calls leave from this
service's own egress address, so together they also share whatever per-source
limit the Glomo API applies.

The client address comes from `X-Forwarded-For` only across `TRUST_PROXY_HOPS`
trusted proxies; with none trusted (the default) the header is ignored.

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

HTTP surface:

| Variable                              | Default                   | Description                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY_HOPS`                    | `0`                       | How many proxies in front of the app to trust for the client address (Express `trust proxy`), 0–5. `0` trusts none and ignores `X-Forwarded-For`. Required on Render: the app refuses to start there without it, and anywhere on an invalid value. Verify it with `CLIENT_IP_DIAGNOSTIC`.      |
| `RATE_LIMIT_FLOOD_PER_MINUTE`         | `1200`                    | Flood guard: requests to `/mcp` per client address per minute, verified or not.                                                                                                                                                                                                                |
| `RATE_LIMIT_PER_MINUTE`               | `300`                     | Requests per client address per minute from callers without a verified credential.                                                                                                                                                                                                             |
| `RATE_LIMIT_MERCHANT_PER_MINUTE`      | `600`                     | Requests per verified merchant per minute, from any address.                                                                                                                                                                                                                                   |
| `RATE_LIMIT_EXECUTION_PER_MINUTE`     | `60`                      | Execution calls per verified merchant (or per address without one) per minute.                                                                                                                                                                                                                 |
| `RATE_LIMIT_SHARED_EGRESS_CIDRS`      | Anthropic's egress ranges | Comma-separated CIDR ranges that get the shared-egress budget. Empty turns it off.                                                                                                                                                                                                             |
| `RATE_LIMIT_SHARED_EGRESS_PER_MINUTE` | `3000`                    | Requests to `/mcp` per minute for an address in those ranges.                                                                                                                                                                                                                                  |
| `CLIENT_IP_DIAGNOSTIC`                | off                       | `1` logs a `client ip diagnostic` line (at most 10 per process) for each request whose `X-Forwarded-For` carries an address from `203.0.113.0/24`: positions and booleans that show whether `TRUST_PROXY_HOPS` resolves the real client. It never logs an address, header value or credential. |

Without `GLOMO_MCP_PUBLIC_KEY` and `GLOMO_MCP_AUDIENCE`, the execution tools fail
closed (every credential is rejected); discovery still works.

`API_HOST` is the origin only — the versioned base path (`/api/v1`, `/api/v2`) is
resolved per operation from the spec.

### Telemetry

All telemetry is off unless configured, so local runs, CI and tests send nothing.

| Variable                      | Default            | Description                                                                                                                      |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `MIXPANEL_TOKEN`              | —                  | Mixpanel project token. Unset: product analytics is a no-op.                                                                     |
| `MIXPANEL_HOST`               | `api.mixpanel.com` | Mixpanel ingestion host (or full origin), e.g. for a regional data-residency endpoint.                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —                  | OTLP/HTTP collector base URL. Unset: OpenTelemetry is not started.                                                               |
| `OTEL_EXPORTER_OTLP_HEADERS`  | —                  | Headers sent with every OTLP export, e.g. `authorization=Bearer <token>`.                                                        |
| `OTEL_METRICS_EXPORTER`       | `otlp`             | `otlp` exports metrics with traces and logs; `none` turns metrics export off. Other values are unsupported and also turn it off. |
| `DEPLOYMENT_ENVIRONMENT`      | —                  | Sets the `deployment.environment` resource attribute on every span, metric and log, e.g. `production`, `sandbox`.                |

- **Product analytics (Mixpanel).** `mcp_session_submitted` on `initialize`, `mcp_tool_submitted` on every
  `tools/call` (`status` = `success`/`failed`), and `mcp_tool_failed` with an `error_code` when a call fails:
  `validation_error`, `unknown_operation`, `auth_missing`, `auth_invalid` (the credential failed verification),
  `auth_rejected` (the API answered 401/403), `sandbox_only` (a read or write with a credential whose `env` is
  not `sandbox`), `upstream_4xx`, `upstream_5xx`, `timeout` or `internal`.
  Events are batched and fire-and-forget over the `/track` endpoint, with at most 4 requests in flight, a
  10 s timeout per request and a bounded queue; anything undeliverable is counted in `mcp.analytics.dropped`.
  A Mixpanel failure never affects a tool response, and IP geolocation is off. `distinct_id`/`merchant_id`
  and `environment`/`mode` come only from a credential that passed `CredentialVerifier` (its `sub` and `env`):
  the dispatcher's own verification for execution calls, the same verifier for `initialize`, discovery tools and
  calls refused before dispatch. With no credential, or one that fails verification, the event is sent
  anonymously (empty `distinct_id`, no `merchant_id`, `environment` or `mode`). The only tool inputs sent are
  `operation_id` and redacted search text (`search_query`, from `glomo_api_search`, `glomo_docs_search` and the
  `glomo_implementation_planner` goal); arguments, bodies and tokens are never sent. Accepted residual risk:
  the redactor masks structured values (emails, UPI IDs, phone, card, Aadhaar and PAN numbers, digit runs of
  9 or more, keys and tokens) but not personal names or IDs shorter than 9 digits, so free text such as "refund to Jane Doe" can reach `search_query`.
- **Traces, metrics and logs (OpenTelemetry, `service.name` = `glomo-mcp-server`).** One span per
  `tools/call` with a child span for the downstream API call, whose URL is recorded as the operation's path
  template (never the concrete path or query). Incoming HTTP requests are not traced. `mcp.tool.calls`,
  `mcp.tool.duration` and `mcp.analytics.dropped` metrics, plus `mcp.http.rejected` (by `reason` and, for
  `rate_limited`, `limiter`) for requests turned away before the MCP transport, which never send a Mixpanel
  event. JSON logs on stdout carrying the trace context, also exported over OTLP. Each `glomo_api_write` call writes one audit log line (merchant, operation, HTTP status and
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

Deployed as a web service on Render from `render.yaml` (a Blueprint),
auto-deploying `main` once its CI checks pass. `API_HOST` is set in the Render
dashboard (`sync: false`).

To confirm `TRUST_PROXY_HOPS` after a deploy or platform change, on **every
hostname that reaches the service** (the custom domain, and the `onrender.com`
subdomain while it is enabled):

1. Set `CLIENT_IP_DIAGNOSTIC=1`.
2. On each hostname, send one request carrying a forged first entry, e.g.
   `curl -s -X POST https://<host>/mcp -H 'X-Forwarded-For: 203.0.113.7' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`.
3. Read its `client ip diagnostic` line (`onRenderSubdomain` tells the two apart).
   The value is right when `suggestedTrustProxyHops` equals `trustProxyHops`,
   `reqIpIndexFromRight` is one less, and `reqIpIsMarker` and `reqIpIsPrivate`
   are both `false`. `reqIpIsMarker: true` means too many hops are trusted (the
   address is spoofable); `reqIpIsPrivate: true` means too few. `True-Client-IP`,
   when something sets it, is only a cross-check (`reqIpEqualsTrueClientIp`).
4. Fix `TRUST_PROXY_HOPS` if needed, then unset the flag.

## Security

Execution tools are sandbox-only and fail closed: the credential's `env` claim must
be exactly `sandbox`.

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities. Do not commit
secrets, API keys, or JWTs to this repository.
