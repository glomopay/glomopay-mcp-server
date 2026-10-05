# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in the Glomo MCP
server, please report it privately. **Do not open a public GitHub issue for
security reports.**

Email `security@glomopay.com` with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any relevant logs or configuration (with secrets redacted).

We will acknowledge your report and keep you informed of progress toward a fix.

## Scope

This repository is the MCP server that proxies the Glomo external API. In
scope: the tool surface, the request dispatcher, the allowlist, and the auth
boundary. Vulnerabilities in the underlying Glomo API itself should be
reported through the same channel.

## Handling of credentials

Callers authenticate with their own MCP credential: an expiring, MCP-audience
token minted with their test secret key. The server verifies it and never
accepts a secret key. The server stores no long-lived credentials.

- Never commit secrets, API keys, or JWTs to this repository — including in
  documentation or example configuration.
- If a secret is committed, treat it as compromised and rotate it immediately.
  Removing it from the repository does not make it safe to keep using.
