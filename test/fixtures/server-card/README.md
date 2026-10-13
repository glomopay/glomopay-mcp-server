# Server Card schema fixtures

`schema.json`, `valid/` and `invalid/` are copied unchanged from
[modelcontextprotocol/experimental-ext-server-card](https://github.com/modelcontextprotocol/experimental-ext-server-card)
at commit `526201bbc80231daa40ffcdecfc9da4e54e5dc93` (12 Aug 2026), licensed Apache-2.0.

They are vendored because the published `$schema` URL
(`https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`) returns 404, so a test can't
fetch it. To update, copy the same files from a newer commit and change the hash above.
