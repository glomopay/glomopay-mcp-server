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

Execution is exposed through two generic tools plus a health check:

| Tool              | Methods           | Description                                 |
| ----------------- | ----------------- | ------------------------------------------- |
| `glomo_api_read`  | GET               | Run a read-only operation by `operationId`. |
| `glomo_api_write` | POST/PATCH/DELETE | Run a write operation by `operationId`.     |
| `healthCheck`     | —                 | Smoke-test tool; returns a greeting.        |

The discovery tools let an agent locate the right `operationId`, inspect its
schema, and get a ready-to-run sample before calling it. They index the whole
published OpenAPI spec and mark each operation with an `executable` flag:
allowlisted operations carry the tool that runs them
(`glomo_api_read`/`glomo_api_write`), and the rest are returned as documentation
only (`executable: false`) so an agent can still read their schema without being
able to run them. `glomo_sample_request` renders the credential as a
`$GLOMO_API_KEY` placeholder. `glomo_implementation_planner` is a registered
placeholder that points callers to `glomo_docs_search` and the published skills
until authored per-flow call sequences land. They need no credential
(the caller's bearer is still required at the transport, see below).

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

Every request must carry `Authorization: Bearer <glomopay-secret>`. The bearer is
the caller's own downstream Glomopay API secret (API-key pass-through): the server
holds no secret of its own and proxies each call under the caller's key. Credential
handling is isolated behind a single seam
(`src/features/auth/credential-resolver.ts`) so it can be replaced by the
follow-on MCP token flow without touching the tool layer.

## Configuration

Environment variables:

| Variable           | Default        | Description                                          |
| ------------------ | -------------- | ---------------------------------------------------- |
| `API_HOST`         | —              | API origin, e.g. `https://api.glomopay.com`.         |
| `PORT`             | `3000`         | Port to listen on.                                   |
| `HOST`             | `127.0.0.1`    | Bind address.                                        |
| `OPENAPI_SPEC_URL` | docs.glomo.one | Build-time spec source (overridable for CI/testing). |

`API_HOST` is the origin only — the versioned base path (`/api/v1`, `/api/v2`) is
resolved per operation from the spec.

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

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer <your-glomopay-secret>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deployment

Deployed as a web service on Render, auto-deploying from `main`. See
`render.yaml`. `API_HOST` is set in the Render dashboard (`sync: false`).

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities. Do not commit
secrets, API keys, or JWTs to this repository.
