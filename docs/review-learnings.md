# Review learnings

Recurring review findings on this repo, distilled so we don't re-introduce them. Read this before starting a feature/PR, and add a bullet whenever a review surfaces a new class of issue.

## Tests

- A test must fail when the code it guards is removed. Assert the **reason** (error message / status) **and** that the protected path was not taken — e.g. an interceptor on the downstream route whose `scope.isDone()` stays `false`. A test that passes with the feature deleted is worthless.
- Use **recorded `nock.back` cassettes** of the real API, not hand-written `.reply()` bodies that drift. Assert a real status and a real body field. Record on realistic data where naive logic would slip through (e.g. an excerpt built from the first N chars must be tested on content where the match sits deep).
- Type-check `test/` too (a `tsc --noEmit` config or vitest typecheck). Keep test paths cwd-independent (`import.meta.dirname` / `__dirname`, not `process.cwd()`). Clean up temp files in `afterAll`.

## External fetches (spec, docs)

- **Fail closed**: any non-200 or wrong content-type fails the build (with one retry), like the spec fetch. Never ship a partial artefact.
- **Pin the origin**: validate every URL with `new URL()`, require `https:` and the exact host, and exclude off-host / wrong-type / duplicate entries.
- Fetch at build time into `dist/`; never vendor, never fetch at runtime.

## Server / architecture

- Extract a factory (`createApp`) so tests exercise the real bootstrap, not a drifting copy.
- Construct a fresh `McpServer` per request (stateless); prove isolation with two distinct credentials, header matching, and overlapping requests.
- Keep credential resolution in **one seam**; writes are sandbox-only via the (unverified) `env` claim, fail-closed; don't thread credentials through tools. Credential-free tools should ultimately need no bearer (per-tool auth).
- Allowlists are a deliberate, reviewed, external-only subset — drop admin, credential-management, unserved and technically-broken operations. Cap tool inputs (`min`/`max`).

## CI / infra

- Keep `.nvmrc` and `render.yaml` Node in sync, at/above the toolchain's engine floor; CI reads `node-version-file`. Test the Node that runs in production.
- Public repo CI: `permissions: contents: read`, and pin actions to commit SHAs.

## Hygiene

- Never commit secrets; scrub cassettes (auth headers, cookies, request/trace ids, PII).
- No dead code or unused exports/params. No code comments unless a reviewer asks for a specific "why".
- Put the Jira key in the PR title; keep `README.md` and `CLAUDE.md` in sync with the code.
