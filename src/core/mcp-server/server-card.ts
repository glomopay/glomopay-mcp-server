import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

import { MCPServer } from './mcp-server';

/** SEP-2127 MCP Server Card: https://modelcontextprotocol.io/seps/2127-mcp-server-cards */
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';

const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
/** The canonical public address. mcp.glomopay.com is an alias and is not advertised. */
const PUBLIC_MCP_URL = 'https://mcp.glomo.one/mcp';

export interface IServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  remotes: {
    type: 'streamable-http';
    url: string;
    headers: {
      name: string;
      description: string;
      isRequired: boolean;
      isSecret: boolean;
      value: string;
      variables: Record<string, { description: string; isRequired: boolean; isSecret: boolean }>;
    }[];
    supportedProtocolVersions: string[];
  }[];
}

/**
 * Built from the values `initialize` returns (`MCPServer.SERVER_VERSION`, the SDK's protocol versions), so the
 * card can't drift from the server it describes. It lists no tools: SEP-2127 leaves primitives to `tools/list`.
 */
export function buildServerCard(): IServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: 'one.glomo/mcp',
    version: MCPServer.SERVER_VERSION,
    description: 'Glomo docs and API for AI agents: search docs and endpoints, build requests, call the sandbox.',
    title: 'Glomo',
    websiteUrl: 'https://docs.glomo.one/platform/mcp-server',
    repository: { url: 'https://github.com/glomopay/glomopay-mcp-server', source: 'github' },
    remotes: [
      {
        type: 'streamable-http',
        url: PUBLIC_MCP_URL,
        headers: [
          {
            name: 'Authorization',
            description: 'Optional. Discovery tools work without it; glomo_api_read and glomo_api_write need it.',
            isRequired: false,
            isSecret: true,
            value: 'Bearer {mcp_credential}',
            variables: {
              mcp_credential: {
                description: 'MCP credential minted with a test secret key. Not the secret key itself.',
                isRequired: false,
                isSecret: true,
              },
            },
          },
        ],
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}
