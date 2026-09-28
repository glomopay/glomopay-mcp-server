export const config = {
  glomopay: {
    apiHost: process.env.API_HOST,
  },
  http: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || '127.0.0.1',
  },
  auth: {
    mcpPublicKey: process.env.GLOMO_MCP_PUBLIC_KEY,
    mcpAudience: process.env.GLOMO_MCP_AUDIENCE,
  },
};
