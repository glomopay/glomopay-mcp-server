# Glomopay MCP Server

## Project Overview

An MCP (Model Context Protocol) server that exposes the Glomopay **external** API
to AI agents. It presents a small, generic tool surface backed by a reviewed
allowlist and proxies calls to the Glomopay REST API under the caller's own
credential.

The server is built from the published OpenAPI spec
(`https://docs.glomopay.com/openapi.json`) — the same contract the public docs
are generated from. The spec is fetched at **build time** and baked into `dist/`;
it is never vendored into the repo and never fetched at runtime, so the tool
surface cannot drift from the documented API.

Glomopay is a cross-border payment provider (Cards, Pay via Bank, Bank
Transfers, LRS remittance).

## Tech Stack

- **Language**: TypeScript (ES2023 target), CommonJS modules, strict mode
- **Package Manager**: pnpm 10.10.0 (Node 22+)
- **Build**: `tsc` + `tsc-alias` + `scripts/fetch-spec.mjs`
- **Transport**: Streamable HTTP (Express 5), stateless
- **Key Dependencies**:
  - `@modelcontextprotocol/sdk`: MCP protocol
  - `@apidevtools/swagger-parser`: OpenAPI spec parsing / validation
  - `express`: HTTP transport
  - `axios`: downstream HTTP client
  - `zod`: tool input schemas

## Project Structure

```
glomopay-mcp/
  scripts/
    fetch-spec.mjs            # build-time OpenAPI spec download -> dist/openapi.json
  src/
    index.ts                  # composition root: build spec index, register tools, listen
    core/
      http/                   # Express app, stateless POST /mcp
      mcp-server/             # MCPServer singleton over the MCP SDK
      dispatcher/             # spec index + generic execution dispatcher
    features/
      allowlist/              # reviewed operationId allowlist (config)
      api-execution/          # glomopay_api_read / glomopay_api_write tools
      auth/                   # bearer middleware + credential-resolver seam
      app-config/             # env-driven config
      health-check/           # demo/smoke-test tool
    shared/
      api-client/             # axios wrapper (ApiError, optional case conversion)
      case-converter/         # camel/snake conversion (off by default)
      tool/                   # BaseTool abstraction + shared types
  dist/                       # build output, incl. fetched openapi.json (gitignored)
```

Each folder exposes a `*.module.ts` barrel; import through it, not the impl files.

## Architecture

### Request flow

1. `POST /mcp` (`core/http/http-server.ts`) — stateless Streamable HTTP; a new
   transport per request. `apiKeyAuthMiddleware` requires
   `Authorization: Bearer <glomopay-secret>` and exposes it as
   `extra.authInfo.token`.
2. A generic tool (`glomopay_api_read` / `glomopay_api_write`) receives
   `{ operationId, params }` and calls the **dispatcher**.
3. `Dispatcher.dispatch` (`core/dispatcher/dispatcher.ts`): resolves the op in
   the spec index → checks the **allowlist** → checks the tool's permitted HTTP
   methods → refuses production credentials on writes → validates path params →
   splits into path/query/body by OpenAPI location → `resolveCredential(extra)`
   → axios request → JSON result (or the API's status + error body).

### The generic tool surface

Execution is two tools, not one per operation:

- `glomopay_api_read` — GET operations on the allowlist.
- `glomopay_api_write` — POST/PATCH/DELETE operations on the allowlist.

Read/write are split so a client can be granted reads without writes. This
replaced the old ~63-tool auto-generated surface (one `DynamicApiTool` per
operation). The discovery/generation tools in the epic (docs_search, api_search,
api_details, implementation_planner, sample_request) are separate tickets.

### Spec index & versioned URLs (`core/dispatcher/spec-index.ts`)

Indexes every operation by `operationId` with method and param locations.
**URL construction is version-aware**: the spec's server
is `/api/v1` but v2 operations are written `/v2/...`, while the real service
mounts `/api/v1` and `/api/v2` as siblings. So the base URL is the origin only
(`API_HOST`) and each op's full versioned path is resolved here — explicit
`/vN/` kept, otherwise the server's default version prepended. Naive
concatenation would wrongly produce `/api/v1/v2/...`.

### Allowlist (`features/allowlist/allowlist.config.ts`)

Reviewed config keyed by `operationId`, external methods only. Explicit list,
not a wildcard — new spec operations are unreachable until added here. Startup
warns on entries missing from the fetched spec.

### Auth seam (`features/auth/credential-resolver.ts`)

`resolveCredential(extra)` is the single place credentials are read. Today it is
API-key pass-through (the bearer IS the downstream Glomopay secret). The
follow-on MCP token flow replaces this function only — no tool/dispatcher change.

### BaseTool (`shared/tool/base-tool.ts`)

Abstract base for tools. Implement `config` (name/title/description/inputSchema)
and `execute(args, extra)` returning `CallToolResult`. `MCPServer.registerTool`
forwards `config` + `handler` to the SDK.

## Development

```bash
pnpm install
pnpm build     # tsc + tsc-alias, then fetch spec into dist/ (fails if unreachable)
API_HOST=https://api.glomopay.com pnpm start
```

Path aliases: `@/*` → `src/*` (tsconfig). Prefer absolute imports via `.module.ts`.

### Adding an operation to the surface

Operations are not hand-coded. To expose one, add its `operationId` to
`features/allowlist/allowlist.config.ts` (it must exist in the published spec).
GETs become reachable via `glomopay_api_read`, writes via `glomopay_api_write`.

### Code Style

- OOP + SOLID; extend `BaseTool` rather than modify it.
- TypeScript strict mode; import through `.module.ts` barrels.
- ESLint + Prettier enforced via husky/lint-staged pre-commit.

## Important Notes

- **No STDIO transport.** The server is HTTP-only.
- **Not merchant-exposed** until the auth follow-on (KAN-8620) lands, because
  token pass-through is a spec-prohibited pattern.
- **Never commit secrets/JWTs** — including in docs or example config.
- **Sandbox targeting** for writes is a separate ticket (KAN-8619).
- Case conversion and response schema validation in `ApiClient` exist but are
  off by default.
